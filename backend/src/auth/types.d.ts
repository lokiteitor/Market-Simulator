/**
 * Module augmentation de tipos para autenticación (contrato §11) — [M1 auth]
 *
 * - `FastifyRequest`: identidad del agente autenticado, poblada por el
 *   preHandler `app.authenticate` (src/auth/plugin.ts). En rutas SIN
 *   authenticate estos campos quedan en su valor de decoración ("" / null
 *   lógico) y NO deben leerse.
 * - `FastifyInstance.authenticate`: el preHandler que valida el Bearer.
 * - `@fastify/jwt` FastifyJWT: tipa `request.user` (claims verificados) y el
 *   payload de firma.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- los usos dentro de `declare module "fastify"` resuelven al interface aumentado y eslint no los cuenta
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentRole } from "../types/contracts";
import type { AccessTokenClaims, AccessTokenPayload } from "./tokens";

declare module "fastify" {
  interface FastifyRequest {
    /** agent_id del agente autenticado (claim `sub`). */
    agentId: string;
    /** Rol del agente autenticado (claim `role`). */
    agentRole: AgentRole;
    /** Username del agente autenticado (claim `username`). */
    agentUsername: string;
  }

  interface FastifyInstance {
    /**
     * preHandler de autenticación: valida el Bearer JWT y setea
     * `request.agentId` / `agentRole` / `agentUsername`.
     * Lanza DomainError(invalid_token) → 401 vía el error handler global.
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * preHandler de autorización: exige que el agente autenticado tenga rol
     * `admin`. Debe encadenarse DESPUÉS de `authenticate` (lee `agentRole`).
     * Lanza DomainError(forbidden) → 403 vía el error handler global.
     */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenClaims;
  }
}
