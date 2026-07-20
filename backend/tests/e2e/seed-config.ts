/**
 * Carga de `infra/seed-config.json` para el E2E [M11].
 *
 * La suite lee el MISMO archivo que consume el seed [M9] para conocer la
 * receta rápida `germinado_rapido` (output, duración, salario) y las
 * capacidades por rol (§13), y así calcular expectativas sin hardcodear.
 *
 * Ruta: `E2E_SEED_CONFIG_PATH` o `<repo>/infra/seed-config.json` resuelta
 * desde la ubicación de este archivo (backend/tests/e2e → ../../..).
 */
import { resolve } from "node:path";

export interface SeedProduct {
  key: string;
  name: string;
  unit: string;
  category: string;
}

export interface SeedRecipeInput {
  product: string;
  qty_cent: number;
}

export interface SeedRecipe {
  key: string;
  name: string;
  output: string;
  /** Tipo de instalación requerido para ejecutarla (ADR-021). */
  installation_type: string;
  output_qty_cent: number;
  duration_sim_seconds: number;
  wage_rate_cents_per_sec: number;
  inputs: SeedRecipeInput[];
}

export interface SeedInstallationType {
  key: string;
  name: string;
  role: string;
  unit_label: string;
  base_price_cents: number;
  growth_bps: number;
  max_level: number;
  recipes: string[];
}

export interface SeedRoleConfig {
  initial_agents: number;
}

export interface SeedConfig {
  products: SeedProduct[];
  recipes: SeedRecipe[];
  installation_types: SeedInstallationType[];
  roles: Record<string, SeedRoleConfig>;
}

export const FAST_RECIPE_KEY = "germinado_rapido";

export async function loadSeedConfig(): Promise<SeedConfig> {
  const path =
    process.env.E2E_SEED_CONFIG_PATH ?? resolve(import.meta.dir, "../../../infra/seed-config.json");
  const cfg = (await Bun.file(path).json()) as SeedConfig;
  if (
    !Array.isArray(cfg.products) ||
    !Array.isArray(cfg.recipes) ||
    !Array.isArray(cfg.installation_types) ||
    typeof cfg.roles !== "object"
  ) {
    throw new Error(
      `seed-config inválido en ${path}: faltan products/recipes/installation_types/roles`,
    );
  }
  return cfg;
}

/** Receta del seed-config por key (falla si no existe). */
export function seedRecipe(cfg: SeedConfig, key: string): SeedRecipe {
  const r = cfg.recipes.find((x) => x.key === key);
  if (r === undefined) throw new Error(`seed-config: receta "${key}" no encontrada`);
  return r;
}

/** Tipo de instalación del seed-config por key (falla si no existe). */
export function seedInstallationType(
  cfg: SeedConfig,
  key: string,
): SeedInstallationType {
  const t = cfg.installation_types.find((x) => x.key === key);
  if (t === undefined)
    throw new Error(`seed-config: installation_type "${key}" no encontrado`);
  return t;
}

/** Producto del seed-config por key (falla si no existe). */
export function seedProduct(cfg: SeedConfig, key: string): SeedProduct {
  const p = cfg.products.find((x) => x.key === key);
  if (p === undefined) throw new Error(`seed-config: producto "${key}" no encontrado`);
  return p;
}
