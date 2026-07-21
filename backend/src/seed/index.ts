/**
 * Barrel del seed: superficie pública del módulo (usada por los tests
 * unitarios y por scripts). El entrypoint ejecutable es `cli.ts`.
 */
export { buildAgentPlan, type SeedAgentPlanEntry } from "./agent-plan";
export { catalogCosts, type CatalogCosts } from "./catalog-costs";
export { parseCitiesConfig, type CitiesConfig } from "./cities";
export { buildCityPlan, type SeedCityPlanEntry } from "./city-plan";
export {
  buildDepositPlan,
  DEPOSIT_RNG_PREFIX,
  type SeedDepositPlanEntry,
} from "./deposit-plan";
export { buildGoldPlan, GOLD_DEPOSIT_RNG_KEY, type GoldPlan } from "./gold-plan";
export { runSeed } from "./run-seed";
export { parseSeedConfig, seedConfigHash, type SeedConfig } from "./seed-config";
