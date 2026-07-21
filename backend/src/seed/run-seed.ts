/**
 * Seed inicial del mercado (contrato §13) — [M9 seed]
 *
 * Ejecutable vía `src/seed/cli.ts` (script `bun run seed`). Comportamiento:
 *
 *   - IDEMPOTENTE: si la tabla `product` ya tiene filas, loguea y sale con 0.
 *   - Lee `infra/seed-config.json` (ruta en `config.seedConfigPath`, relativa
 *     al cwd), lo valida con Zod y verifica integridad referencial
 *     (outputs/inputs de recetas → productos; capacidades → recetas).
 *   - Inserta products, recipes (+recipe_inputs) y los agentes iniciales por
 *     rol (`{role}_{i}`, 1-based) con credenciales (argon2id, la MISMA función
 *     de M1 `src/auth/password.ts`), capital semilla DETERMINISTA
 *     (`rngFor(masterSeed, username)` + `randIntInclusive` en el rango del
 *     rol) y capacidades del rol. TODO en UNA transacción.
 *   - Por agente: `appendEvent(agent_registered)` con payload §9 extendido
 *     con `{seed_config_hash, master_seed}` (§13: la config usada se registra
 *     en el event log, NO en un market_snapshot).
 *   - NO publica notificaciones Redis: durante el seed no hay nadie conectado.
 *   - Resumen final por stdout vía logger (agentes, productos, recetas,
 *     capital total).
 *
 * `duration_sim_seconds` del JSON se convierte a INTERVAL de Postgres como
 * string `'<n> seconds'` al insertar (la columna `recipe.duration` es INTERVAL
 * en tiempo SIMULADO, contrato §4).
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashPassword } from "../auth/password";
import { config, type AgentRoleKey } from "../config";
import { withTransaction } from "../db";
import {
  agent,
  agentCredentials,
  goldStandard,
  installationType,
  inventoryLot,
  product,
  recipe,
  recipeInput,
  resourceDeposit,
} from "../db/schema";
import { appendEvent, type AgentRegisteredPayload } from "../lib/event-log";
import { logger } from "../observability/logger";
import { buildAgentPlan } from "./agent-plan";
import { parseCitiesConfig } from "./cities";
import { buildCityPlan } from "./city-plan";
import { buildGoldPlan, type GoldPlan } from "./gold-plan";
import { parseSeedConfig, seedConfigHash } from "./seed-config";

/** Payload agent_registered del seed: §9 + config usada (§13). */
interface SeedAgentRegisteredPayload extends AgentRegisteredPayload {
  seed_config_hash: string;
  master_seed: number;
}

interface SeedSummary {
  products: number;
  recipes: number;
  recipeInputs: number;
  agents: number;
  totalCapitalCents: number;
  byRole: Record<AgentRoleKey, { agents: number; capitalCents: number }>;
  cities: { count: number; capitalCents: number };
  gold: GoldPlan;
}

function mustGet(map: Map<string, string>, key: string, what: string): string {
  const value = map.get(key);
  if (value === undefined) {
    // parseSeedConfig ya validó las referencias; esto solo puede ocurrir por
    // un bug interno del propio seed.
    throw new Error(`seed: ${what} "${key}" sin id resuelto`);
  }
  return value;
}

/**
 * Ejecuta el seed completo. Devuelve "skipped" si la DB ya estaba sembrada
 * (tabla product no vacía) o "seeded" si insertó el catálogo y los agentes.
 */
export async function runSeed(): Promise<"seeded" | "skipped"> {
  const seedConfigPath = resolve(process.cwd(), config.seedConfigPath);
  const rawJson = await readFile(seedConfigPath, "utf8");
  const cfg = parseSeedConfig(rawJson);
  const configHash = seedConfigHash(rawJson);

  // Fail-fast del patrón oro: el producto-respaldo debe existir en el catálogo.
  if (!cfg.products.some((p) => p.key === config.gold.productKey)) {
    throw new Error(
      `seed: GOLD_PRODUCT_KEY "${config.gold.productKey}" no existe en el catálogo del seed-config`,
    );
  }

  const plan = buildAgentPlan(cfg, {
    masterSeed: config.masterSeed,
    capitalRanges: config.seedCapitalRanges,
  });

  // Los hashes argon2id son costosos: se calculan ANTES de abrir la tx para
  // no alargarla. Misma contraseña para todos (SEED_AGENT_PASSWORD), pero un
  // hash por agente (salt única por fila).
  const planWithHashes = await Promise.all(
    plan.map(async (entry) => ({
      ...entry,
      passwordHash: await hashPassword(config.seedAgentPassword),
    })),
  );

  // Ciudades-consumidor: lista canónica (fuente única compartida con
  // bots-ciudad). Capital semilla ∝ population_weight. Credenciales con
  // CITY_SEED_PASSWORD para que los bots hagan login (login-only).
  const citiesConfigPath = resolve(process.cwd(), config.cities.configPath);
  const citiesRaw = await readFile(citiesConfigPath, "utf8");
  const citiesCfg = parseCitiesConfig(citiesRaw);
  const cityPlan = buildCityPlan(citiesCfg, {
    capitalCentsPerWeight: config.cities.seedCapitalCentsPerWeight,
  });
  const cityPlanWithHashes = await Promise.all(
    cityPlan.map(async (entry) => ({
      ...entry,
      passwordHash: await hashPassword(config.cities.seedPassword),
    })),
  );

  const result = await withTransaction(async (tx) => {
    // Idempotencia (§13): si ya hay productos, la DB está sembrada.
    const existing = await tx
      .select({ productId: product.productId })
      .from(product)
      .limit(1);
    if (existing.length > 0) {
      return null;
    }

    // --- Productos -----------------------------------------------------------
    const productIdByKey = new Map<string, string>();
    for (const p of cfg.products) {
      const rows = await tx
        .insert(product)
        .values({ key: p.key, name: p.name, unit: p.unit, category: p.category })
        .returning({ productId: product.productId });
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`seed: insert de product "${p.key}" no devolvió fila`);
      }
      productIdByKey.set(p.key, row.productId);
    }

    // --- Tipos de instalación (ADR-021) --------------------------------------
    const installationTypeIdByKey = new Map<string, string>();
    for (const it of cfg.installation_types) {
      const rows = await tx
        .insert(installationType)
        .values({
          key: it.key,
          name: it.name,
          role: it.role,
          unitLabel: it.unit_label,
          basePriceCents: it.base_price_cents,
          growthBps: it.growth_bps,
          maxLevel: it.max_level,
        })
        .returning({ installationTypeId: installationType.installationTypeId });
      const row = rows[0];
      if (row === undefined) {
        throw new Error(
          `seed: insert de installation_type "${it.key}" no devolvió fila`,
        );
      }
      installationTypeIdByKey.set(it.key, row.installationTypeId);
    }

    // --- Recetas + insumos ---------------------------------------------------
    const recipeIdByKey = new Map<string, string>();
    let recipeInputCount = 0;
    for (const r of cfg.recipes) {
      const rows = await tx
        .insert(recipe)
        .values({
          outputProductId: mustGet(productIdByKey, r.output, "producto"),
          outputQty: r.output_qty_cent,
          // duration_sim_seconds → INTERVAL de Postgres (string '<n> seconds').
          duration: `${r.duration_sim_seconds} seconds`,
          wageRateCentsPerSec: r.wage_rate_cents_per_sec,
          installationTypeId: mustGet(
            installationTypeIdByKey,
            r.installation_type,
            "tipo de instalación",
          ),
          name: r.name,
        })
        .returning({ recipeId: recipe.recipeId });
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`seed: insert de recipe "${r.key}" no devolvió fila`);
      }
      recipeIdByKey.set(r.key, row.recipeId);

      if (r.inputs.length > 0) {
        await tx.insert(recipeInput).values(
          r.inputs.map((input) => ({
            recipeId: row.recipeId,
            productId: mustGet(productIdByKey, input.product, "producto"),
            qtyRequired: input.qty_cent,
          })),
        );
        recipeInputCount += r.inputs.length;
      }
    }

    // Los agentes NO reciben instalaciones al sembrarse (ADR-021): nacen sin
    // filas en agent_installation y deben comprar/subir de nivel vía
    // POST /agents/me/installations.

    // --- Agentes iniciales ---------------------------------------------------
    const byRole: SeedSummary["byRole"] = {
      primary_producer: { agents: 0, capitalCents: 0 },
      transformer: { agents: 0, capitalCents: 0 },
      consumer: { agents: 0, capitalCents: 0 },
      trader: { agents: 0, capitalCents: 0 },
    };
    let totalCapitalCents = 0;

    for (const entry of planWithHashes) {
      const agentRows = await tx
        .insert(agent)
        .values({
          username: entry.username,
          role: entry.role,
          status: "active",
          capitalAvailable: entry.capitalCents,
          capitalReserved: 0,
          seedCapital: entry.capitalCents,
        })
        .returning({ agentId: agent.agentId });
      const agentRow = agentRows[0];
      if (agentRow === undefined) {
        throw new Error(
          `seed: insert de agent "${entry.username}" no devolvió fila`,
        );
      }
      const agentId = agentRow.agentId;

      await tx.insert(agentCredentials).values({
        agentId,
        passwordHash: entry.passwordHash,
      });

      const payload: SeedAgentRegisteredPayload = {
        agent_id: agentId,
        username: entry.username,
        role: entry.role,
        seed_capital_cents: entry.capitalCents,
        seed_config_hash: configHash,
        master_seed: config.masterSeed,
      };
      await appendEvent(tx, { type: "agent_registered", agentId, payload });

      byRole[entry.role].agents += 1;
      byRole[entry.role].capitalCents += entry.capitalCents;
      totalCapitalCents += entry.capitalCents;
    }

    // --- Ciudades-consumidor (demanda urbana sembrada) -----------------------
    // Rol `city`: CON credenciales (login de bots-ciudad), capital ∝ población,
    // sin capacidades. Participan del mercado (SEEDABLE_MARKET_ROLES), así que
    // su capital cuenta en la masa monetaria inicial que respalda el oro.
    let totalCityCapitalCents = 0;
    let citiesSeeded = 0;
    for (const entry of cityPlanWithHashes) {
      const cityRows = await tx
        .insert(agent)
        .values({
          username: entry.username,
          role: "city",
          status: "active",
          capitalAvailable: entry.capitalCents,
          capitalReserved: 0,
          seedCapital: entry.capitalCents,
          populationWeight: entry.populationWeight,
        })
        .returning({ agentId: agent.agentId });
      const cityRow = cityRows[0];
      if (cityRow === undefined) {
        throw new Error(`seed: insert de ciudad "${entry.username}" no devolvió fila`);
      }
      await tx.insert(agentCredentials).values({
        agentId: cityRow.agentId,
        passwordHash: entry.passwordHash,
      });
      const cityPayload: SeedAgentRegisteredPayload = {
        agent_id: cityRow.agentId,
        username: entry.username,
        role: "city",
        seed_capital_cents: entry.capitalCents,
        seed_config_hash: configHash,
        master_seed: config.masterSeed,
      };
      await appendEvent(tx, {
        type: "agent_registered",
        agentId: cityRow.agentId,
        payload: cityPayload,
      });
      totalCityCapitalCents += entry.capitalCents;
      citiesSeeded += 1;
    }

    // --- Patrón oro: banco central + yacimiento + política monetaria ---------
    // La paridad se calcula con el capital de mercado YA sembrado (agentes de
    // mercado + ciudades), de modo que la masa inicial queda respaldada por
    // construcción.
    const gold = buildGoldPlan(totalCapitalCents + totalCityCapitalCents, {
      masterSeed: config.masterSeed,
      gold: config.gold,
    });
    const goldProductId = mustGet(productIdByKey, config.gold.productKey, "producto");

    // Banco central: agente único SIN credenciales (no logueable) y sin
    // capacidades. Su capital inicial da liquidez contable a la emisión de
    // registros antes de acumular fees.
    const bankRows = await tx
      .insert(agent)
      .values({
        username: config.gold.bankUsername,
        role: "bank",
        status: "active",
        capitalAvailable: config.gold.bankInitialCapitalCents,
        capitalReserved: 0,
        seedCapital: config.gold.bankInitialCapitalCents,
      })
      .returning({ agentId: agent.agentId });
    const bankRow = bankRows[0];
    if (bankRow === undefined) {
      throw new Error(`seed: insert del banco "${config.gold.bankUsername}" no devolvió fila`);
    }
    const bankAgentId = bankRow.agentId;

    // Reserva inicial de oro del banco como lote normal (origin 'initial',
    // costo 0: no salió de ningún circuito).
    if (gold.bankGoldQtyCent > 0) {
      await tx.insert(inventoryLot).values({
        agentId: bankAgentId,
        productId: goldProductId,
        origin: "initial",
        qtyOriginal: gold.bankGoldQtyCent,
        qtyAvailable: gold.bankGoldQtyCent,
        qtyReserved: 0,
        unitCostCents: 0,
      });
    }

    // Yacimiento minable (lo que no se llevó el banco).
    await tx.insert(resourceDeposit).values({
      productId: goldProductId,
      qtyInitialCent: gold.minableQtyCent,
      qtyRemainingCent: gold.minableQtyCent,
    });

    // Política monetaria de la corrida (singleton; fija salvo contadores).
    await tx.insert(goldStandard).values({
      singleton: true,
      bankAgentId,
      productId: goldProductId,
      parityCentsPerUnit: gold.parityCentsPerUnit,
      windowBidCents: gold.windowBidCents,
      windowAskCents: gold.windowAskCents,
      coverageRatioBps: config.gold.coverageRatioBps,
      initialMoneyCents: gold.initialMoneyCents,
      moneyIssuedCents: 0,
      moneyBurnedCents: 0,
    });

    const bankPayload: SeedAgentRegisteredPayload = {
      agent_id: bankAgentId,
      username: config.gold.bankUsername,
      role: "bank",
      seed_capital_cents: config.gold.bankInitialCapitalCents,
      seed_config_hash: configHash,
      master_seed: config.masterSeed,
    };
    await appendEvent(tx, {
      type: "agent_registered",
      agentId: bankAgentId,
      payload: bankPayload,
    });

    const summary: SeedSummary = {
      products: cfg.products.length,
      recipes: cfg.recipes.length,
      recipeInputs: recipeInputCount,
      agents: planWithHashes.length,
      totalCapitalCents,
      byRole,
      cities: { count: citiesSeeded, capitalCents: totalCityCapitalCents },
      gold,
    };
    return summary;
  });

  if (result === null) {
    logger.info(
      { seedConfigPath },
      "Seed ya aplicado (tabla product no vacía) — no se hace nada",
    );
    return "skipped";
  }

  logger.info(
    {
      seedConfigPath,
      seedConfigHash: configHash,
      masterSeed: config.masterSeed,
      products: result.products,
      recipes: result.recipes,
      recipeInputs: result.recipeInputs,
      agents: result.agents,
      byRole: result.byRole,
      totalCapitalCents: result.totalCapitalCents,
      cities: result.cities,
      gold: result.gold,
    },
    "Seed completado",
  );
  return "seeded";
}
