/**
 * Repositorio del catálogo (product, recipe, recipe_input) — [M6 read-side].
 *
 * Lecturas del read-side + escrituras usadas SOLO por el seed (el catálogo es
 * inmutable durante la corrida). Recibe `tx` como primer parámetro (contrato
 * §0); las transacciones las abre SOLO el service con `withTransaction`.
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

  // -------------------------------------------------------------------------
  // Escrituras (solo seed)
  // -------------------------------------------------------------------------

  /** ¿Hay algún producto? Check de idempotencia del seed (§13). */
  async hasAnyProduct(tx: Tx): Promise<boolean> {
    const rows = await tx
      .select({ productId: product.productId })
      .from(product)
      .limit(1);
    return rows.length > 0;
  },

  async insertProduct(
    tx: Tx,
    p: {
      key: string;
      name: string;
      unit: string;
      category: ProductRow["category"];
    },
  ): Promise<{ productId: string }> {
    const rows = await tx
      .insert(product)
      .values(p)
      .returning({ productId: product.productId });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("product insert returned no rows");
    }
    return row;
  },

  async insertRecipe(
    tx: Tx,
    p: {
      name: string;
      outputProductId: string;
      outputQtyCent: number;
      /** Duración de UNA ejecución en segundos SIMULADOS (contrato §4). */
      durationSimSeconds: number;
      wageRateCentsPerSec: number;
      installationTypeId: string;
    },
  ): Promise<{ recipeId: string }> {
    const rows = await tx
      .insert(recipe)
      .values({
        name: p.name,
        outputProductId: p.outputProductId,
        outputQty: p.outputQtyCent,
        // La columna es INTERVAL: se persiste como string '<n> seconds'.
        duration: `${p.durationSimSeconds} seconds`,
        wageRateCentsPerSec: p.wageRateCentsPerSec,
        installationTypeId: p.installationTypeId,
      })
      .returning({ recipeId: recipe.recipeId });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("recipe insert returned no rows");
    }
    return row;
  },

  async insertRecipeInputs(
    tx: Tx,
    recipeId: string,
    inputs: Array<{ productId: string; qtyCent: number }>,
  ): Promise<void> {
    if (inputs.length === 0) return;
    await tx.insert(recipeInput).values(
      inputs.map((input) => ({
        recipeId,
        productId: input.productId,
        qtyRequired: input.qtyCent,
      })),
    );
  },
};
