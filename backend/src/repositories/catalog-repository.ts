/**
 * Repositorio del catálogo (product, recipe, recipe_input) — [M6 read-side].
 *
 * Lecturas puras. Recibe `tx` como primer parámetro (contrato §0); las
 * transacciones las abre SOLO el service con `withTransaction`.
 */
import { asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "../db";
import {
  product,
  recipe,
  recipeInput,
  type ProductRow,
  type RecipeInputRow,
  type RecipeRow,
} from "../db/schema";

export const catalogRepository = {
  /** Todos los productos, orden estable por PK (uuidv7 ≈ orden de creación). */
  async listProducts(tx: Tx): Promise<ProductRow[]> {
    return tx.select().from(product).orderBy(asc(product.productId));
  },

  async getProduct(tx: Tx, productId: string): Promise<ProductRow | undefined> {
    const rows = await tx
      .select()
      .from(product)
      .where(eq(product.productId, productId))
      .limit(1);
    return rows[0];
  },

  /** Recetas, opcionalmente filtradas por producto de salida (openapi). */
  async listRecipes(tx: Tx, outputProductId?: string): Promise<RecipeRow[]> {
    return tx
      .select()
      .from(recipe)
      .where(
        outputProductId !== undefined
          ? eq(recipe.outputProductId, outputProductId)
          : undefined,
      )
      .orderBy(asc(recipe.recipeId));
  },

  async getRecipe(tx: Tx, recipeId: string): Promise<RecipeRow | undefined> {
    const rows = await tx
      .select()
      .from(recipe)
      .where(eq(recipe.recipeId, recipeId))
      .limit(1);
    return rows[0];
  },

  /** Insumos de un conjunto de recetas (para ensamblar `Recipe.inputs`). */
  async listInputsForRecipes(
    tx: Tx,
    recipeIds: string[],
  ): Promise<RecipeInputRow[]> {
    if (recipeIds.length === 0) return [];
    return tx
      .select()
      .from(recipeInput)
      .where(inArray(recipeInput.recipeId, recipeIds))
      .orderBy(asc(recipeInput.recipeId), asc(recipeInput.productId));
  },
};
