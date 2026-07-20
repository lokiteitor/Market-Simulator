/**
 * Controller del catálogo: orquesta el service y mapea filas → DTOs snake_case
 * del openapi — [M6 read-side].
 *
 * Conversión de duración (openapi manda): la DB guarda `recipe.duration` como
 * INTERVAL en tiempo SIMULADO (contrato §4), pero `Recipe.duration_seconds`
 * del openapi es la duración de UNA ejecución en segundos REALES
 * ("no simulados"). Se convierte con el factor de simulación:
 * realSeconds = simSeconds / SIM_TIME_FACTOR (p. ej. 60 s sim con factor 5 →
 * 12 s reales). Se redondea al entero más cercano con piso 1 (openapi:
 * integer, minimum 1).
 */
import type { ProductRow, RecipeInputRow } from "../db/schema";
import { cachedJson } from "../lib/read-cache";
import { intervalToSimSeconds, simSecondsToRealMs } from "../lib/simtime";
import type { ProductDto, RecipeDto, RecipeInputDto } from "../schemas/catalog";
import { catalogService, type RecipeWithInputs } from "../services/catalog-service";

// El catálogo es estático durante la corrida (solo lo escribe el seed, que es
// idempotente y puede re-ejecutarse con el core vivo): TTL de 60 s en vez de
// infinito para que un re-seed se refleje solo, sin invalidación explícita.
const CATALOG_TTL_MS = 60_000;

/** INTERVAL simulado de la DB → segundos REALES enteros (openapi `duration_seconds`). */
export function recipeDurationRealSeconds(durationInterval: string): number {
  const simSeconds = intervalToSimSeconds(durationInterval);
  return Math.max(1, Math.round(simSecondsToRealMs(simSeconds) / 1000));
}

export function toProductDto(row: ProductRow): ProductDto {
  return {
    product_id: row.productId,
    key: row.key,
    name: row.name,
    unit: row.unit,
    category: row.category,
    created_at: row.createdAt.toISOString(),
  };
}

function toRecipeInputDto(row: RecipeInputRow): RecipeInputDto {
  return {
    product_id: row.productId,
    qty_required_cent: row.qtyRequired,
  };
}

export function toRecipeDto(row: RecipeWithInputs): RecipeDto {
  return {
    recipe_id: row.recipeId,
    name: row.name,
    output_product_id: row.outputProductId,
    output_qty_cent: row.outputQty,
    duration_seconds: recipeDurationRealSeconds(row.duration),
    wage_rate_cents_per_sec: row.wageRateCentsPerSec,
    installation_type_id: row.installationTypeId,
    inputs: row.inputs.map(toRecipeInputDto),
    created_at: row.createdAt.toISOString(),
  };
}

export const catalogController = {
  async listProducts(): Promise<ProductDto[]> {
    return cachedJson("products", "cache:catalog:products", CATALOG_TTL_MS, async () => {
      const rows = await catalogService.listProducts();
      return rows.map(toProductDto);
    });
  },

  async getProduct(productId: string): Promise<ProductDto> {
    return toProductDto(await catalogService.getProduct(productId));
  },

  async listRecipes(outputProductId?: string): Promise<RecipeDto[]> {
    return cachedJson(
      "recipes",
      `cache:catalog:recipes:${outputProductId ?? "all"}`,
      CATALOG_TTL_MS,
      async () => {
        const rows = await catalogService.listRecipes(outputProductId);
        return rows.map(toRecipeDto);
      },
    );
  },

  async getRecipe(recipeId: string): Promise<RecipeDto> {
    return toRecipeDto(await catalogService.getRecipe(recipeId));
  },
};
