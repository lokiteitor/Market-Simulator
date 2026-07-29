/**
 * Schemas Zod del catálogo (openapi: Product, RecipeInput, Recipe) — [M6 read-side].
 *
 * La API habla snake_case; los DTOs de estos schemas son la forma EXACTA que
 * viaja por HTTP. Nota de contrato (openapi manda):
 *   - `output_qty_cent` / `qty_required_cent` mapean a las columnas
 *     `output_qty` / `qty_required` del schema SQL.
 *   - `duration_seconds` es la duración de UNA ejecución en segundos REALES
 *     (no simulados) — la conversión desde el INTERVAL simulado de la DB la
 *     hace el controller (ver catalog-controller.recipeDurationRealSeconds).
 */
import { z } from "zod";
import { productCategory, urbanRole } from "../db/schema";

export const ProductCategorySchema = z.enum(productCategory.enumValues);

/** Papel del producto en la economía urbana (ADR-029). */
export const UrbanRoleSchema = z.enum(urbanRole.enumValues);

export const ProductSchema = z.object({
  product_id: z.uuid(),
  key: z.string(),
  name: z.string(),
  unit: z.string(),
  category: ProductCategorySchema,
  /**
   * Coste propagado por el grafo de recetas: la referencia de valor del
   * producto (el mismo número que los precios base de los bots). NO es un
   * precio de mercado.
   */
  reference_cost_cents: z.number().int().min(1),
  /**
   * Papel en la economía urbana (ADR-029): `basket` = las ciudades lo consumen
   * y lo destruyen cada periodo; `housing` = lo absorben para crecer. null en
   * materias primas e intermedios.
   */
  urban_role: UrbanRoleSchema.nullable(),
  created_at: z.iso.datetime(),
});

export type ProductDto = z.infer<typeof ProductSchema>;

export const RecipeInputSchema = z.object({
  product_id: z.uuid(),
  qty_required_cent: z.number().int().min(1),
});

export type RecipeInputDto = z.infer<typeof RecipeInputSchema>;

export const RecipeSchema = z.object({
  recipe_id: z.uuid(),
  /**
   * Clave estable del catálogo (seed-config, ej. `cultivo_trigo`). Espejo de
   * `Product.key`: es lo que permite a un cliente nombrar una receta concreta
   * sin depender del UUID (regenerado en cada seed) ni del `name` de display.
   */
  key: z.string(),
  name: z.string(),
  output_product_id: z.uuid(),
  output_qty_cent: z.number().int().min(1),
  /** Segundos REALES de una ejecución (openapi `Recipe.duration_seconds`). */
  duration_seconds: z.number().int().min(1),
  wage_rate_cents_per_sec: z.number().int().min(0),
  /** Tipo de instalación requerido para ejecutarla (ADR-021). */
  installation_type_id: z.uuid(),
  inputs: z.array(RecipeInputSchema),
  created_at: z.iso.datetime(),
});

export type RecipeDto = z.infer<typeof RecipeSchema>;

/**
 * Yacimiento finito de un recurso no renovable (openapi Deposit, ADR-023).
 *
 * A diferencia de productos y recetas, este sub-recurso del catálogo es
 * DINÁMICO: `qty_remaining_cent` y `yield_bps` cambian con cada materialización
 * que extrae del yacimiento.
 */
export const DepositSchema = z.object({
  product_id: z.uuid(),
  /** `key` del producto: evita al cliente cruzar con /catalog/products. */
  product_key: z.string(),
  qty_initial_cent: z.number().int().min(0),
  qty_remaining_cent: z.number().int().min(0),
  /**
   * Rendimiento actual sobre el output nominal de la receta (10000 = 100%). Lo
   * calcula el servidor para que el cliente no replique la fórmula ni tenga que
   * conocer el suelo configurado.
   */
  yield_bps: z.number().int().min(0).max(10000),
});

export type DepositDto = z.infer<typeof DepositSchema>;

/** Path param `{product_id}` (openapi ProductIdPath, format uuid). */
export const ProductIdParamsSchema = z.object({ product_id: z.uuid() });

/** Path param `{recipe_id}` (openapi RecipeIdPath, format uuid). */
export const RecipeIdParamsSchema = z.object({ recipe_id: z.uuid() });

/** Query de GET /catalog/recipes. */
export const ListRecipesQuerySchema = z.object({
  output_product_id: z.uuid().optional(),
});

export type ListRecipesQuery = z.infer<typeof ListRecipesQuerySchema>;
