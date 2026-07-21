/**
 * Plan determinista de ciudades-consumidor: capital semilla proporcional al
 * peso de población. Sin RNG: el peso ya es la fuente de la heterogeneidad.
 */
import type { CitiesConfig } from "./cities";

export interface SeedCityPlanEntry {
  username: string;
  populationWeight: number;
  /** Capital semilla = population_weight * capitalCentsPerWeight (∝ población). */
  capitalCents: number;
}

/**
 * Plan determinista de ciudades: capital semilla proporcional al peso de
 * población (Tokyo empieza mucho más rica que Reikiavik). Sin RNG: el peso ya
 * es la fuente de la heterogeneidad.
 */
export function buildCityPlan(
  cfg: CitiesConfig,
  opts: { capitalCentsPerWeight: number },
): SeedCityPlanEntry[] {
  return cfg.cities.map((c) => ({
    username: c.username,
    populationWeight: c.population_weight,
    capitalCents: c.population_weight * opts.capitalCentsPerWeight,
  }));
}
