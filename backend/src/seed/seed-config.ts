/**
 * Schema Zod y parseo de `infra/seed-config.json` (estructura REAL del
 * catálogo: productos, recetas, tipos de instalación ADR-021 y agentes
 * iniciales por rol). Además del schema, `parseSeedConfig` verifica la
 * integridad referencial completa (claves únicas, outputs/inputs → productos,
 * cobertura exacta receta↔installation_type).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { agentRole, productCategory } from "../db/schema";
import { parseJsonConfig } from "../lib/json-config";

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
  /** Tipo de instalación requerido para ejecutar la receta (ADR-021). */
  installation_type: z.string().min(1),
  output_qty_cent: z.number().int().positive(),
  /** Duración de UNA ejecución, en segundos SIMULADOS. */
  duration_sim_seconds: z.number().int().positive(),
  wage_rate_cents_per_sec: z.number().int().nonnegative(),
  inputs: z.array(SeedRecipeInputSchema),
});

// Tipo de instalación comprable/mejorable (ADR-021). Agrupa recetas afines; el
// nivel es el presupuesto de concurrencia compartido entre ellas.
const SeedInstallationTypeSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(agentRole.enumValues),
  unit_label: z.string().min(1),
  base_price_cents: z.number().int().positive(),
  growth_bps: z.number().int().positive(),
  max_level: z.number().int().positive(),
  recipes: z.array(z.string().min(1)),
});

const SeedRoleSchema = z.object({
  initial_agents: z.number().int().nonnegative(),
});

const SeedConfigSchema = z.object({
  products: z.array(SeedProductSchema).min(1),
  recipes: z.array(SeedRecipeSchema),
  installation_types: z.array(SeedInstallationTypeSchema).min(1),
  roles: z.object({
    transformer: SeedRoleSchema,
    consumer: SeedRoleSchema,
    trader: SeedRoleSchema,
  }),
});

export type SeedConfig = z.infer<typeof SeedConfigSchema>;

/**
 * Parsea y valida el JSON del seed-config: schema Zod + integridad
 * referencial (claves únicas, outputs/inputs → productos, capacidades →
 * recetas). Lanza Error con mensaje claro si algo no cuadra.
 */
export function parseSeedConfig(rawJson: string): SeedConfig {
  const cfg = parseJsonConfig(rawJson, SeedConfigSchema, "seed-config");

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

  // --- Tipos de instalación: keys únicas y cobertura receta→tipo exacta -------
  const installationTypeKeys = new Set<string>();
  const recipeToType = new Map<string, string>();
  for (const it of cfg.installation_types) {
    if (installationTypeKeys.has(it.key)) {
      throw new Error(`seed-config: installation_type key duplicada: "${it.key}"`);
    }
    installationTypeKeys.add(it.key);
    for (const rk of it.recipes) {
      if (!recipeKeys.has(rk)) {
        throw new Error(
          `seed-config: installation_type "${it.key}" referencia una receta desconocida: "${rk}"`,
        );
      }
      const prev = recipeToType.get(rk);
      if (prev !== undefined) {
        throw new Error(
          `seed-config: receta "${rk}" asignada a dos tipos ("${prev}" y "${it.key}")`,
        );
      }
      recipeToType.set(rk, it.key);
    }
  }
  // Cada receta debe declarar un installation_type existente y coincidir con el
  // tipo que la lista en `recipes` (cobertura total, sin recetas huérfanas).
  for (const r of cfg.recipes) {
    if (!installationTypeKeys.has(r.installation_type)) {
      throw new Error(
        `seed-config: recipe "${r.key}" declara un installation_type desconocido: "${r.installation_type}"`,
      );
    }
    const owner = recipeToType.get(r.key);
    if (owner === undefined) {
      throw new Error(
        `seed-config: recipe "${r.key}" no está listada en las recipes de ningún installation_type`,
      );
    }
    if (owner !== r.installation_type) {
      throw new Error(
        `seed-config: recipe "${r.key}" declara tipo "${r.installation_type}" pero está listada en "${owner}"`,
      );
    }
  }

  return cfg;
}

/** SHA-256 hex del contenido crudo del seed-config (para el event log, §13). */
export function seedConfigHash(rawJson: string): string {
  return createHash("sha256").update(rawJson, "utf8").digest("hex");
}
