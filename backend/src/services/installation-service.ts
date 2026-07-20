/**
 * Service de instalaciones (economía de instalaciones, ADR-021).
 *
 * Las instalaciones son "lugares" productivos (campos→hectáreas,
 * industrias→líneas de producción) que el agente COMPRA y SUBE DE NIVEL. El
 * nivel es el presupuesto de concurrencia COMPARTIDO entre todas las recetas del
 * tipo (ver la validación per-tipo en transformation-service). Nadie recibe
 * instalaciones al inicio.
 *
 * Compra/mejora (una sola operación, `acquireOrUpgrade`) en una tx:
 *   1. lockAgent FOR UPDATE (serializa compras concurrentes del mismo agente);
 *      bankrupt ⇒ agent_bankrupt.
 *   2. Resolver el tipo por key ⇒ unknown_installation_type.
 *   3. Validar rol ⇒ installation_role_mismatch.
 *   4. Nivel actual (0 si no existe); expectedCurrentLevel opcional ⇒
 *      conflict_state; nivel >= max_level ⇒ installation_max_level.
 *   5. Precio = installationUpgradePriceCents(base, growth, nivel); débito
 *      atómico ⇒ insufficient_capital.
 *   6. UPSERT del nivel (+1).
 *   7. El pago se acredita al BANCO vía fee_ledger (tradeId NULL, append-only,
 *      sin lock de gold_standard ni fila caliente). El fee-ledger-sweeper lo
 *      pliega al capital del banco; la conservación ya suma pendingFees.
 *   8. appendEvent(installation_purchased) dentro de la tx.
 *   9. Notificación WS personal post-commit (best-effort).
 */
import { withTransaction } from "../db";
import { domainError } from "../lib/errors";
import { appendEvent, type InstallationPurchasedPayload } from "../lib/event-log";
import { installationUpgradePriceCents } from "../lib/installations";
import { publishToAgent } from "../notifier";
import { logger } from "../observability/logger";
import { agentRepository } from "../repositories/agent-repository";
import { feeLedgerRepository } from "../repositories/fee-ledger-repository";
import {
  installationRepository,
  type InstallationWithRunning,
} from "../repositories/installation-repository";

const log = logger.child({ mod: "installation-service" });

/** Un tipo de instalación comprable (catálogo). */
export interface InstallationTypeView {
  installationTypeId: string;
  key: string;
  name: string;
  role: string;
  unitLabel: string;
  basePriceCents: number;
  growthBps: number;
  maxLevel: number;
}

/** Estado de una instalación del agente (nivel + concurrencia + precio siguiente). */
export interface InstallationStatusView {
  installationType: string;
  name: string;
  unitLabel: string;
  level: number;
  running: number;
  availableSlots: number;
  /** Precio de la siguiente mejora, o null si ya está en nivel máximo. */
  nextUpgradePriceCents: number | null;
}

/** Resultado de comprar/mejorar: el estado nuevo + lo cobrado. */
export interface AcquireInstallationResult extends InstallationStatusView {
  amountChargedCents: number;
}

function nextUpgradePrice(inst: {
  basePriceCents: number;
  growthBps: number;
  maxLevel: number;
  level: number;
}): number | null {
  if (inst.level >= inst.maxLevel) return null;
  return installationUpgradePriceCents(
    inst.basePriceCents,
    inst.growthBps,
    inst.level,
  );
}

function toStatusView(inst: InstallationWithRunning): InstallationStatusView {
  return {
    installationType: inst.key,
    name: inst.name,
    unitLabel: inst.unitLabel,
    level: inst.level,
    running: inst.running,
    availableSlots: Math.max(0, inst.level - inst.running),
    nextUpgradePriceCents: nextUpgradePrice(inst),
  };
}

export const installationService = {
  /** Catálogo de tipos comprables (GET /catalog/installation-types). */
  async getCatalog(): Promise<InstallationTypeView[]> {
    return withTransaction(async (tx) => {
      const types = await installationRepository.listTypes(tx);
      return types.map((t) => ({
        installationTypeId: t.installationTypeId,
        key: t.key,
        name: t.name,
        role: t.role,
        unitLabel: t.unitLabel,
        basePriceCents: t.basePriceCents,
        growthBps: t.growthBps,
        maxLevel: t.maxLevel,
      }));
    });
  },

  /** Instalaciones compradas por el agente (GET /agents/me/installations). */
  async getInstallations(agentId: string): Promise<InstallationStatusView[]> {
    return withTransaction(async (tx) => {
      const rows = await installationRepository.listForAgentWithRunning(tx, agentId);
      return rows.map(toStatusView);
    });
  },

  /**
   * Compra (nivel 0→1) o mejora (+1) una instalación del tipo dado.
   * `expectedCurrentLevel` (opcional) permite concurrencia optimista del bot:
   * si el nivel actual no coincide, falla con conflict_state en vez de cobrar.
   */
  async acquireOrUpgrade(
    agentId: string,
    input: { installationTypeKey: string; expectedCurrentLevel?: number },
  ): Promise<AcquireInstallationResult> {
    const result = await withTransaction(async (tx) => {
      const agent = await agentRepository.findByIdForUpdate(tx, agentId);
      if (agent === undefined) {
        throw domainError("unknown_agent", `Agente ${agentId} desconocido.`);
      }
      if (agent.status === "bankrupt") {
        throw domainError(
          "agent_bankrupt",
          "Un agente en quiebra no puede comprar instalaciones.",
        );
      }

      const type = await installationRepository.findTypeByKey(
        tx,
        input.installationTypeKey,
      );
      if (type === undefined) {
        throw domainError(
          "unknown_installation_type",
          `Tipo de instalación "${input.installationTypeKey}" desconocido.`,
          { field: "installation_type" },
        );
      }
      if (type.role !== agent.role) {
        throw domainError(
          "installation_role_mismatch",
          `El rol "${agent.role}" no puede comprar instalaciones de tipo "${type.key}" (rol "${type.role}").`,
          { field: "installation_type" },
        );
      }

      const currentLevel =
        (await installationRepository.getLevel(
          tx,
          agentId,
          type.installationTypeId,
        )) ?? 0;

      if (
        input.expectedCurrentLevel !== undefined &&
        input.expectedCurrentLevel !== currentLevel
      ) {
        throw domainError(
          "conflict_state",
          `Nivel esperado ${input.expectedCurrentLevel} pero el actual es ${currentLevel}.`,
          { field: "expected_current_level" },
        );
      }
      if (currentLevel >= type.maxLevel) {
        throw domainError(
          "installation_max_level",
          `La instalación "${type.key}" ya está en nivel máximo (${type.maxLevel}).`,
          { field: "installation_type" },
        );
      }

      const priceCents = installationUpgradePriceCents(
        type.basePriceCents,
        type.growthBps,
        currentLevel,
      );
      // Débito atómico condicional (§10.3) ⇒ insufficient_capital si no alcanza.
      await agentRepository.debitAvailable(tx, agentId, priceCents);

      const newLevel = currentLevel + 1;
      await installationRepository.upsertLevel(
        tx,
        agentId,
        type.installationTypeId,
        newLevel,
      );

      // El pago va al banco central (ADR-021) vía el ledger append-only.
      await feeLedgerRepository.insertFee(tx, {
        tradeId: null,
        amountCents: priceCents,
      });

      const payload: InstallationPurchasedPayload = {
        agent_id: agentId,
        installation_type_id: type.installationTypeId,
        installation_type: type.key,
        level: newLevel,
        amount_cents: priceCents,
      };
      await appendEvent(tx, { type: "installation_purchased", agentId, payload });

      const running = await installationRepository.countRunningForType(
        tx,
        agentId,
        type.installationTypeId,
      );
      const status: AcquireInstallationResult = {
        installationType: type.key,
        name: type.name,
        unitLabel: type.unitLabel,
        level: newLevel,
        running,
        availableSlots: Math.max(0, newLevel - running),
        nextUpgradePriceCents: nextUpgradePrice({
          basePriceCents: type.basePriceCents,
          growthBps: type.growthBps,
          maxLevel: type.maxLevel,
          level: newLevel,
        }),
        amountChargedCents: priceCents,
      };
      return status;
    });

    // Notificación personal post-commit, best-effort.
    try {
      await publishToAgent(agentId, {
        type: "installation_purchased",
        occurred_at: new Date().toISOString(),
        payload: result,
      });
    } catch (err) {
      log.warn(
        { err, agentId, installationType: result.installationType },
        "fallo notificando installation_purchased",
      );
    }
    return result;
  },
};
