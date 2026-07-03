/**
 * Rutas /auth/* (contrato §11, openapi) — [M1 auth]
 *
 * SIN prefijo /v1: lo aplica [M10] con `app.register(registerAuthRoutes,
 * { prefix: "/v1" })`. register/login/refresh son públicas; logout requiere
 * `app.authenticate` (decorado por src/auth/plugin.ts, registrado antes por
 * [M10]).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { authController } from "../controllers/auth-controller";
import {
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterAgentRequestSchema,
  RegisterAgentResponseSchema,
  TokenPairSchema,
} from "../schemas/auth";

export function registerAuthRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/auth/register",
    {
      schema: {
        body: RegisterAgentRequestSchema,
        response: { 201: RegisterAgentResponseSchema },
      },
    },
    authController.register,
  );

  r.post(
    "/auth/login",
    {
      schema: {
        body: LoginRequestSchema,
        response: { 200: TokenPairSchema },
      },
    },
    authController.login,
  );

  r.post(
    "/auth/refresh",
    {
      schema: {
        body: RefreshRequestSchema,
        response: { 200: TokenPairSchema },
      },
    },
    authController.refresh,
  );

  r.post(
    "/auth/logout",
    {
      preHandler: [app.authenticate],
      schema: {
        body: RefreshRequestSchema,
        // 204 sin cuerpo: no se declara response schema.
      },
    },
    authController.logout,
  );
}
