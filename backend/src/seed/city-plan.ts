/**
 * Plan determinista de ciudades-consumidor. Desde ADR-029 es deliberadamente
 * TRIVIAL: todas las ciudades nacen idénticas (misma población, mismo capital),
 * porque la heterogeneidad ya no es un dato de entrada sino el resultado de la
 * partida — cada ciudad crece absorbiendo viviendas y se encoge si no las
 * repone. Sigue existiendo como función pura para que el seed no calcule nada
 * inline y para poder testear el contrato sin DB.
 */
import type { CitiesConfig } from "./cities";

export interface SeedCityPlanEntry {
  username: string;
  /** Habitantes iniciales; idéntico en todas las ciudades. */
  population: number;
  /** Capital semilla; idéntico en todas las ciudades. */
  capitalCents: number;
}

/**
 * Plan determinista de ciudades: población y capital semilla uniformes. Sin RNG
 * y sin ponderaciones — lo que diferencie a dos ciudades tendrá que ganárselo
 * comprando vivienda.
 */
export function buildCityPlan(
  cfg: CitiesConfig,
  opts: { initialPopulation: number; capitalCents: number },
): SeedCityPlanEntry[] {
  return cfg.cities.map((c) => ({
    username: c.username,
    population: opts.initialPopulation,
    capitalCents: opts.capitalCents,
  }));
}
