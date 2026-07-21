/**
 * Plan determinista de agentes iniciales de mercado (§13): capital semilla
 * derivado EXCLUSIVAMENTE de (masterSeed, username).
 */
import type { AgentRoleKey, SeedCapitalRange } from "../config";
import { randIntInclusive, rngFor } from "../lib/rng";
import { MARKET_ROLES, type MarketRole } from "../types/contracts";
import type { SeedConfig } from "./seed-config";

/** Orden canónico de roles de MERCADO: plan determinista (excluye `admin`). */
const ROLE_ORDER: readonly MarketRole[] = MARKET_ROLES;

export interface SeedAgentPlanEntry {
  /** `{role}_{i}` con i 1-based (p. ej. `transformer_1`). */
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
