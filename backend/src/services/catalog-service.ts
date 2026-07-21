/**
 * Service del catálogo (lecturas puras) — [M6 read-side].
 *
 * El catálogo es estático durante la corrida (diseño §2.1). 404 con códigos
 * unknown_product / unknown_recipe (contrato §6).
 */
import { withTransaction } from "../db";
import type { ProductRow, RecipeInputRow, RecipeRow } from "../db/schema";
import { domainError } from "../lib/errors";
import { catalogRepository } from "../repositories/catalog-repository";
import {
  depositRepository,
  type DepositWithProduct,
} from "../repositories/deposit-repository";

/** Receta con sus insumos ensamblados (openapi `Recipe.inputs`). */
export interface RecipeWithInputs extends RecipeRow {
  inputs: RecipeInputRow[];
}

function groupInputsByRecipe(
  inputs: RecipeInputRow[],
): Map<string, RecipeInputRow[]> {
  const byRecipe = new Map<string, RecipeInputRow[]>();
  for (const input of inputs) {
    const list = byRecipe.get(input.recipeId);
    if (list === undefined) {
      byRecipe.set(input.recipeId, [input]);
    } else {
      list.push(input);
    }
  }
  return byRecipe;
}

export const catalogService = {
  async listProducts(): Promise<ProductRow[]> {
    return withTransaction((tx) => catalogRepository.listProducts(tx));
  },

  /** @throws DomainError unknown_product (404) */
  async getProduct(productId: string): Promise<ProductRow> {
    const row = await withTransaction((tx) =>
      catalogRepository.getProduct(tx, productId),
    );
    if (row === undefined) {
      throw domainError(
        "unknown_product",
        `No existe el producto ${productId}.`,
        { field: "product_id" },
      );
    }
    return row;
  },

  async listRecipes(outputProductId?: string): Promise<RecipeWithInputs[]> {
    return withTransaction(async (tx) => {
      const recipes = await catalogRepository.listRecipes(tx, outputProductId);
      const inputs = await catalogRepository.listInputsForRecipes(
        tx,
        recipes.map((r) => r.recipeId),
      );
      const byRecipe = groupInputsByRecipe(inputs);
      return recipes.map((r) => ({
        ...r,
        inputs: byRecipe.get(r.recipeId) ?? [],
      }));
    });
  },

  /**
   * Yacimientos finitos (ADR-023). ÚNICA lectura dinámica de este service: el
   * remanente baja con cada materialización que extrae del yacimiento.
   */
  async listDeposits(): Promise<DepositWithProduct[]> {
    return withTransaction((tx) => depositRepository.listAll(tx));
  },

  /** @throws DomainError unknown_recipe (404) */
  async getRecipe(recipeId: string): Promise<RecipeWithInputs> {
    return withTransaction(async (tx) => {
      const row = await catalogRepository.getRecipe(tx, recipeId);
      if (row === undefined) {
        throw domainError("unknown_recipe", `No existe la receta ${recipeId}.`, {
          field: "recipe_id",
        });
      }
      const inputs = await catalogRepository.listInputsForRecipes(tx, [
        row.recipeId,
      ]);
      return { ...row, inputs };
    });
  },
};
