/**
 * Seed inicial del mercado (contrato §13) — [M9 seed]
 *
 * Ejecutable con `bun src/seed.ts` (script `bun run seed`). Comportamiento:
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
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { hashPassword } from "./auth/password";
import { config, type AgentRoleKey, type SeedCapitalRange } from "./config";
import { closeDb, withTransaction } from "./db";
import {
  agent,
  agentCapacity,
  agentCredentials,
  product,
  productCategory,
  recipe,
  recipeInput,
} from "./db/schema";
import { appendEvent, type AgentRegisteredPayload } from "./lib/event-log";
import { randIntInclusive, rngFor } from "./lib/rng";
import { logger } from "./observability/logger";
import { MARKET_ROLES, type AgentRole, type MarketRole } from "./types/contracts";

// =============================================================================
// Schema Zod del seed-config.json (estructura REAL de infra/seed-config.json)
// =============================================================================

const SeedProductSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1),
  category: z.enum(productCategory.enumValues),
});

const SeedRecipeInputSchema = z.object({
  product: z.string().min(1),
  qty_cent: z.number().int().positive(),
});

const SeedRecipeSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  output: z.string().min(1),
  output_qty_cent: z.number().int().positive(),
  /** Duración de UNA ejecución, en segundos SIMULADOS. */
  duration_sim_seconds: z.number().int().positive(),
  wage_rate_cents_per_sec: z.number().int().nonnegative(),
  inputs: z.array(SeedRecipeInputSchema),
});

const SeedRoleSchema = z.object({
  initial_agents: z.number().int().nonnegative(),
  capacities: z.array(
    z.object({
      recipe: z.string().min(1),
      installations: z.number().int().positive(),
    }),
  ),
});

const SeedConfigSchema = z.object({
  products: z.array(SeedProductSchema).min(1),
  recipes: z.array(SeedRecipeSchema),
  roles: z.object({
    primary_producer: SeedRoleSchema,
    transformer: SeedRoleSchema,
    consumer: SeedRoleSchema,
    trader: SeedRoleSchema,
  }),
});

export type SeedConfig = z.infer<typeof SeedConfigSchema>;

/** Orden canónico de roles de MERCADO: plan determinista (excluye `admin`). */
const ROLE_ORDER: readonly MarketRole[] = MARKET_ROLES;

// =============================================================================
// Funciones puras (testeables sin DB)
// =============================================================================

/**
 * Parsea y valida el JSON del seed-config: schema Zod + integridad
 * referencial (claves únicas, outputs/inputs → productos, capacidades →
 * recetas). Lanza Error con mensaje claro si algo no cuadra.
 */
export function parseSeedConfig(rawJson: string): SeedConfig {
  let data: unknown;
  try {
    data = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`seed-config: JSON inválido: ${(err as Error).message}`);
  }

  const parsed = SeedConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("\n");
    throw new Error(`seed-config: estructura inválida:\n${issues}`);
  }
  const cfg = parsed.data;

  // --- Integridad referencial -----------------------------------------------
  const productKeys = new Set<string>();
  const productNames = new Set<string>();
  for (const p of cfg.products) {
    if (productKeys.has(p.key)) {
      throw new Error(`seed-config: product key duplicada: "${p.key}"`);
    }
    if (productNames.has(p.name)) {
      throw new Error(`seed-config: product name duplicado: "${p.name}"`);
    }
    productKeys.add(p.key);
    productNames.add(p.name);
  }

  const recipeKeys = new Set<string>();
  const recipeNames = new Set<string>();
  for (const r of cfg.recipes) {
    if (recipeKeys.has(r.key)) {
      throw new Error(`seed-config: recipe key duplicada: "${r.key}"`);
    }
    if (recipeNames.has(r.name)) {
      throw new Error(`seed-config: recipe name duplicado: "${r.name}"`);
    }
    recipeKeys.add(r.key);
    recipeNames.add(r.name);

    if (!productKeys.has(r.output)) {
      throw new Error(
        `seed-config: recipe "${r.key}" produce un producto desconocido: "${r.output}"`,
      );
    }
    const inputProducts = new Set<string>();
    for (const input of r.inputs) {
      if (!productKeys.has(input.product)) {
        throw new Error(
          `seed-config: recipe "${r.key}" consume un producto desconocido: "${input.product}"`,
        );
      }
      if (inputProducts.has(input.product)) {
        throw new Error(
          `seed-config: recipe "${r.key}" repite el insumo "${input.product}"`,
        );
      }
      inputProducts.add(input.product);
    }
  }

  for (const role of ROLE_ORDER) {
    const seenRecipes = new Set<string>();
    for (const cap of cfg.roles[role].capacities) {
      if (!recipeKeys.has(cap.recipe)) {
        throw new Error(
          `seed-config: rol "${role}" referencia una receta desconocida: "${cap.recipe}"`,
        );
      }
      if (seenRecipes.has(cap.recipe)) {
        throw new Error(
          `seed-config: rol "${role}" repite la capacidad "${cap.recipe}"`,
        );
      }
      seenRecipes.add(cap.recipe);
    }
  }

  return cfg;
}

/** SHA-256 hex del contenido crudo del seed-config (para el event log, §13). */
export function seedConfigHash(rawJson: string): string {
  return createHash("sha256").update(rawJson, "utf8").digest("hex");
}

export interface SeedAgentPlanEntry {
  /** `{role}_{i}` con i 1-based (p. ej. `primary_producer_1`). */
  username: string;
  role: MarketRole;
  /** Capital semilla determinista: rngFor(masterSeed, username) en el rango del rol. */
  capitalCents: number;
}

/**
 * Plan determinista de agentes iniciales: por cada rol (orden canónico del
 * enum), `initial_agents` agentes con capital derivado EXCLUSIVAMENTE de
 * (masterSeed, username) — independiente del orden de inicialización (§13).
 */
export function buildAgentPlan(
  cfg: SeedConfig,
  opts: {
    masterSeed: number;
    capitalRanges: Record<AgentRoleKey, SeedCapitalRange>;
  },
): SeedAgentPlanEntry[] {
  const plan: SeedAgentPlanEntry[] = [];
  for (const role of ROLE_ORDER) {
    const range = opts.capitalRanges[role];
    const count = cfg.roles[role].initial_agents;
    for (let i = 1; i <= count; i++) {
      const username = `${role}_${i}`;
      const rng = rngFor(opts.masterSeed, username);
      plan.push({
        username,
        role,
        capitalCents: randIntInclusive(rng, range.minCents, range.maxCents),
      });
    }
  }
  return plan;
}

// =============================================================================
// Seed (DB)
// =============================================================================

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
        .values({ name: p.name, unit: p.unit, category: p.category })
        .returning({ productId: product.productId });
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`seed: insert de product "${p.key}" no devolvió fila`);
      }
      productIdByKey.set(p.key, row.productId);
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

    // Capacidades por rol resueltas a recipe_id (una vez, no por agente).
    const capacitiesByRole = new Map<
      MarketRole,
      Array<{ recipeId: string; installations: number }>
    >();
    for (const role of ROLE_ORDER) {
      capacitiesByRole.set(
        role,
        cfg.roles[role].capacities.map((cap) => ({
          recipeId: mustGet(recipeIdByKey, cap.recipe, "receta"),
          installations: cap.installations,
        })),
      );
    }

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

      const capacities = capacitiesByRole.get(entry.role) ?? [];
      if (capacities.length > 0) {
        await tx.insert(agentCapacity).values(
          capacities.map((cap) => ({
            agentId,
            recipeId: cap.recipeId,
            installations: cap.installations,
          })),
        );
      }

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

    const summary: SeedSummary = {
      products: cfg.products.length,
      recipes: cfg.recipes.length,
      recipeInputs: recipeInputCount,
      agents: planWithHashes.length,
      totalCapitalCents,
      byRole,
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
    },
    "Seed completado",
  );
  return "seeded";
}

// =============================================================================
// Entrypoint CLI (`bun src/seed.ts`)
// =============================================================================

if (import.meta.main) {
  try {
    await runSeed();
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Seed falló — rollback total (transacción única)");
    await closeDb().catch(() => {
      // El pool puede no haberse abierto nunca; el exit code ya refleja el fallo.
    });
    process.exit(1);
  }
}
