/**
 * Controller de /auth/* — [M1 auth]
 *
 * Traduce entre el contrato HTTP (snake_case, openapi) y los services
 * (camelCase). Los bodies llegan YA validados por los schemas Zod de la
 * ruta; los errores de dominio los mapea el error handler global [M10].
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  LoginRequestBody,
  RefreshRequestBody,
  RegisterAgentRequestBody,
  RegisterAgentResponseJson,
  TokenPairJson,
} from "../schemas/auth";
import {
  authService,
  type RegisterResult,
  type TokenPairResult,
} from "../services/auth-service";

function toTokenPairJson(t: TokenPairResult): TokenPairJson {
  return {
    access_token: t.accessToken,
    refresh_token: t.refreshToken,
    token_type: "Bearer",
    access_expires_at: t.accessExpiresAt.toISOString(),
    refresh_expires_at: t.refreshExpiresAt.toISOString(),
  };
}

function toRegisterResponseJson(r: RegisterResult): RegisterAgentResponseJson {
  const a = r.agent;
  return {
    ...toTokenPairJson(r),
    agent: {
      agent: {
        agent_id: a.agentId,
        username: a.username,
        role: a.role,
        status: a.status,
        registered_at: a.registeredAt.toISOString(),
        bankrupt_at: a.bankruptAt === null ? null : a.bankruptAt.toISOString(),
      },
      capital_available_cents: a.capitalAvailable,
      capital_reserved_cents: a.capitalReserved,
      // Agente recién nacido (ADR-021): sin inventario, sin órdenes, sin
      // procesos y SIN instalaciones (las compra después).
      inventory: [],
      active_orders: [],
      running_processes: [],
      installations: [],
      recent_events: [],
    },
  };
}

export const authController = {
  /** POST /auth/register → 201 RegisterAgentResponse. */
  async register(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = request.body as RegisterAgentRequestBody;
    const result = await authService.register({
      username: body.username,
      password: body.password,
      role: body.role,
    });
    await reply.code(201).send(toRegisterResponseJson(result));
  },

  /** POST /auth/login → 200 TokenPair. */
  async login(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = request.body as LoginRequestBody;
    const pair = await authService.login({
      username: body.username,
      password: body.password,
    });
    await reply.code(200).send(toTokenPairJson(pair));
  },

  /** POST /auth/refresh → 200 TokenPair (rotación). */
  async refresh(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = request.body as RefreshRequestBody;
    const pair = await authService.refresh({ refreshToken: body.refresh_token });
    await reply.code(200).send(toTokenPairJson(pair));
  },

  /** POST /auth/logout (autenticado) → 204 sin cuerpo. */
  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = request.body as RefreshRequestBody;
    await authService.logout({
      agentId: request.agentId,
      refreshToken: body.refresh_token,
    });
    await reply.code(204).send();
  },
};
