/**
 * Rutas /catalog/* (openapi tag `catalog`) — [M6 read-side].
 *
 * PÚBLICAS: los GET /catalog/* NO requieren autenticación (arquitectura §9.2),
 * por eso no llevan preHandler `app.authenticate`.
 *
 * M10 registra esta función con prefix "/v1" (contrato §15).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { catalogController } from "../controllers/catalog-controller";
import {
  ListRecipesQuerySchema,
  ProductIdParamsSchema,
  ProductSchema,
  RecipeIdParamsSchema,
  RecipeSchema,
} from "../schemas/catalog";

export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/catalog/products",
    {
      schema: {
        response: { 200: z.array(ProductSchema) },
      },
    },
    async () => catalogController.listProducts(),
  );

  r.get(
    "/catalog/products/:product_id",
    {
      schema: {
        params: ProductIdParamsSchema,
        response: { 200: ProductSchema },
      },
    },
    // 404 unknown_product lo lanza el service (Problem+JSON global en app.ts).
    async (req) => catalogController.getProduct(req.params.product_id),
  );

  r.get(
    "/catalog/recipes",
    {
      schema: {
        querystring: ListRecipesQuerySchema,
        response: { 200: z.array(RecipeSchema) },
      },
    },
    async (req) => catalogController.listRecipes(req.query.output_product_id),
  );

  r.get(
    "/catalog/recipes/:recipe_id",
    {
      schema: {
        params: RecipeIdParamsSchema,
        response: { 200: RecipeSchema },
      },
    },
    // 404 unknown_recipe lo lanza el service.
    async (req) => catalogController.getRecipe(req.params.recipe_id),
  );
}
