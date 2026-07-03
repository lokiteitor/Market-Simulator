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
import { productCategory } from "../db/schema";

export const ProductCategorySchema = z.enum(productCategory.enumValues);

export const ProductSchema = z.object({
  product_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  category: ProductCategorySchema,
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
  name: z.string(),
  output_product_id: z.uuid(),
  output_qty_cent: z.number().int().min(1),
  /** Segundos REALES de una ejecución (openapi `Recipe.duration_seconds`). */
  duration_seconds: z.number().int().min(1),
  wage_rate_cents_per_sec: z.number().int().min(0),
  inputs: z.array(RecipeInputSchema),
  created_at: z.iso.datetime(),
});

export type RecipeDto = z.infer<typeof RecipeSchema>;

/** Path param `{product_id}` (openapi ProductIdPath, format uuid). */
export const ProductIdParamsSchema = z.object({ product_id: z.uuid() });

/** Path param `{recipe_id}` (openapi RecipeIdPath, format uuid). */
export const RecipeIdParamsSchema = z.object({ recipe_id: z.uuid() });

/** Query de GET /catalog/recipes. */
export const ListRecipesQuerySchema = z.object({
  output_product_id: z.uuid().optional(),
});

export type ListRecipesQuery = z.infer<typeof ListRecipesQuerySchema>;
