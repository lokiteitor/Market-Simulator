/**
 * Rutas /bank/* (ventanilla del banco central, patrón oro) — [bank].
 *
 * AUTENTICADAS (Bearer). El convert está vetado a `bank`/`admin` (403 en el
 * service). Errores 422: insufficient_capital, insufficient_inventory,
 * bank_insufficient_gold, conversion_below_minimum; 409 no_gold_standard.
 *
 * M10 registra esta función con prefix "/v1" (contrato §15).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { bankController } from "../controllers/bank-controller";
import {
  BankInfoSchema,
  ConvertRequestSchema,
  GoldConversionSchema,
} from "../schemas/bank";
import { ProblemSchema } from "../schemas/common";

export function registerBankRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const problems = { 401: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema, 422: ProblemSchema };

  r.get(
    "/bank",
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: BankInfoSchema, ...problems } },
    },
    async () => bankController.getBankInfo(),
  );

  r.post(
    "/bank/convert",
    {
      preHandler: [app.authenticate],
      schema: {
        body: ConvertRequestSchema,
        response: { 201: GoldConversionSchema, ...problems },
      },
    },
    async (req, reply) => {
      const conversion = await bankController.convert(req.agentId, req.body);
      return reply.code(201).send(conversion);
    },
  );
}
