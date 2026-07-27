/**
 * Bootstrap del agente administrador — panel admin + cuenta personal del
 * operador humano (monitorea Y opera el mercado como trader/transformer).
 *
 * Ejecutable con `bun src/seed-admin.ts` (script `bun run seed:admin`).
 *
 *   - IDEMPOTENTE: si ya existe un agente con `config.adminUsername`, no hace
 *     nada y sale con 0.
 *   - Crea UN agente con rol `admin`, status `active` y capital 0; después del
 *     commit lo financia con `fundAgentSeedCapital` (misma vía que el registro
 *     dinámico: capital del banco + acuñación respaldada por oro). Sigue FUERA
 *     de los agregados de mercado (NON_MARKET_ROLES) y exento de quiebra.
 *     Credenciales con argon2id (la misma función de M1).
 *   - Registra el evento de auditoría `agent_registered` (§9).
 *
 * El rol `admin` NO es registrable por POST /auth/register (el schema del body
 * solo admite los 4 roles de mercado): esta es la ÚNICA vía de alta de admins.
 * Las credenciales vienen de ADMIN_USERNAME / ADMIN_PASSWORD (config).
 */
import { hashPassword } from "./auth/password";
import { config } from "./config";
import { closeDb, withTransaction } from "./db";
import { appendEvent, type AgentRegisteredPayload } from "./lib/event-log";
import { logger } from "./observability/logger";
import { agentRepository } from "./repositories/agent-repository";
import { authRepository } from "./repositories/auth-repository";
import { agentService } from "./services/agent-service";

/**
 * Crea el agente admin si no existe. Devuelve "created" o "skipped".
 * Idempotente por username. Tras el commit de la creación lo financia con
 * `fundAgentSeedCapital` (tx propia, idempotente: no hace nada si el agente
 * ya tiene seed_capital > 0), así el admin puede operar el mercado.
 */
export async function ensureAdminAgent(): Promise<"created" | "skipped"> {
  // argon2id es costoso: hashear FUERA de la tx.
  const passwordHash = await hashPassword(config.adminPassword);

  const outcome = await withTransaction(async (tx) => {
    const existing = await authRepository.findAgentByUsername(tx, config.adminUsername);
    if (existing !== null) {
      return { result: "skipped" as const, agentId: existing.agentId };
    }

    const agentRow = await agentRepository.insertAgent(tx, {
      username: config.adminUsername,
      role: "admin",
      seedCapitalCents: 0,
    });
    await authRepository.insertCredentials(tx, {
      agentId: agentRow.agentId,
      passwordHash,
    });

    const payload: AgentRegisteredPayload = {
      agent_id: agentRow.agentId,
      username: agentRow.username,
      role: agentRow.role,
      seed_capital_cents: 0,
    };
    await appendEvent(tx, {
      type: "agent_registered",
      agentId: agentRow.agentId,
      payload,
    });

    return { result: "created" as const, agentId: agentRow.agentId };
  });

  // Financiación FUERA de la tx de creación (misma coreografía que el registro
  // dinámico): requiere el patrón oro ya sembrado (`make seed` corre antes).
  await agentService.fundAgentSeedCapital(outcome.agentId);

  return outcome.result;
}

// ===========================================================================
// Entrypoint CLI (`bun src/seed-admin.ts`)
// ===========================================================================

if (import.meta.main) {
  try {
    const outcome = await ensureAdminAgent();
    logger.info(
      { username: config.adminUsername, outcome },
      outcome === "created"
        ? "Agente admin creado"
        : "Agente admin ya existía — no se hace nada",
    );
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "Bootstrap de admin falló");
    await closeDb().catch(() => {
      // El pool puede no haberse abierto; el exit code ya refleja el fallo.
    });
    process.exit(1);
  }
}
