/**
 * Repositorio de instalaciones (economía de instalaciones, ADR-021) — [M2].
 *
 * Todas las funciones reciben `tx` como primer parámetro; las transacciones se
 * abren SOLO en services (contrato §0). La serialización de compras concurrentes
 * de un mismo agente la garantiza el `lockAgent FOR UPDATE` del service, no un
 * lock propio de estas tablas.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../db";
import {
  agentInstallation,
  installationType,
  recipe,
  transformationProcess,
  type InstallationTypeRow,
} from "../db/schema";

/** Instalación comprada por el agente + tipo + procesos running del tipo. */
export interface InstallationWithRunning {
  installationTypeId: string;
  key: string;
  name: string;
  unitLabel: string;
  basePriceCents: number;
  growthBps: number;
  maxLevel: number;
  level: number;
  running: number;
}

export const installationRepository = {
  /** Catálogo completo de tipos de instalación (para GET /catalog). */
  async listTypes(tx: Tx): Promise<InstallationTypeRow[]> {
    return tx.select().from(installationType).orderBy(asc(installationType.key));
  },

  /** Un tipo por su `key` estable, o undefined si no existe. */
  async findTypeByKey(
    tx: Tx,
    key: string,
  ): Promise<InstallationTypeRow | undefined> {
    const rows = await tx
      .select()
      .from(installationType)
      .where(eq(installationType.key, key))
      .limit(1);
    return rows[0];
  },

  /** Procesos running del agente que consumen la concurrencia de un tipo. */
  async countRunningForType(
    tx: Tx,
    agentId: string,
    installationTypeId: string,
  ): Promise<number> {
    const rows = await tx
      .select({ running: sql<number>`count(*)::int` })
      .from(transformationProcess)
      .innerJoin(recipe, eq(transformationProcess.recipeId, recipe.recipeId))
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.status, "running"),
          eq(recipe.installationTypeId, installationTypeId),
        ),
      );
    return rows[0]?.running ?? 0;
  },

  /** Nivel actual de una instalación del agente, o undefined si no la posee. */
  async getLevel(
    tx: Tx,
    agentId: string,
    installationTypeId: string,
  ): Promise<number | undefined> {
    const rows = await tx
      .select({ level: agentInstallation.level })
      .from(agentInstallation)
      .where(
        and(
          eq(agentInstallation.agentId, agentId),
          eq(agentInstallation.installationTypeId, installationTypeId),
        ),
      )
      .limit(1);
    return rows[0]?.level;
  },

  /**
   * UPSERT del nivel de una instalación del agente. Crea la fila (nivel 1) en la
   * compra inicial o incrementa el nivel en una mejora.
   */
  async upsertLevel(
    tx: Tx,
    agentId: string,
    installationTypeId: string,
    level: number,
  ): Promise<void> {
    await tx
      .insert(agentInstallation)
      .values({ agentId, installationTypeId, level })
      .onConflictDoUpdate({
        target: [agentInstallation.agentId, agentInstallation.installationTypeId],
        set: { level },
      });
  },

  /**
   * Instalaciones del agente con su nivel y el conteo de procesos running que
   * consumen su presupuesto de concurrencia (JOIN process→recipe→tipo). El nivel
   * es COMPARTIDO por todas las recetas del tipo, así que se agrupa por tipo.
   */
  async listForAgentWithRunning(
    tx: Tx,
    agentId: string,
  ): Promise<InstallationWithRunning[]> {
    const owned = await tx
      .select({
        installationTypeId: agentInstallation.installationTypeId,
        key: installationType.key,
        name: installationType.name,
        unitLabel: installationType.unitLabel,
        basePriceCents: installationType.basePriceCents,
        growthBps: installationType.growthBps,
        maxLevel: installationType.maxLevel,
        level: agentInstallation.level,
      })
      .from(agentInstallation)
      .innerJoin(
        installationType,
        eq(agentInstallation.installationTypeId, installationType.installationTypeId),
      )
      .where(eq(agentInstallation.agentId, agentId))
      .orderBy(asc(installationType.key));
    if (owned.length === 0) return [];

    // Procesos running del agente agrupados por tipo de instalación de su receta.
    const counts = await tx
      .select({
        installationTypeId: recipe.installationTypeId,
        running: sql<number>`count(*)::int`,
      })
      .from(transformationProcess)
      .innerJoin(recipe, eq(transformationProcess.recipeId, recipe.recipeId))
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.status, "running"),
        ),
      )
      .groupBy(recipe.installationTypeId);
    const runningByType = new Map(
      counts.map((c) => [c.installationTypeId, c.running]),
    );

    return owned.map((o) => ({
      installationTypeId: o.installationTypeId,
      key: o.key,
      name: o.name,
      unitLabel: o.unitLabel,
      basePriceCents: o.basePriceCents,
      growthBps: o.growthBps,
      maxLevel: o.maxLevel,
      level: o.level,
      running: runningByType.get(o.installationTypeId) ?? 0,
    }));
  },
};
