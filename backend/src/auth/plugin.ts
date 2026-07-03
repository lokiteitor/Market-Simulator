/**
 * Plugin Fastify de autenticación (contrato §11) — [M1 auth]
 *
 * - Registra @fastify/jwt (HS256, `config.jwtSecret`).
 * - Decora `app.authenticate`: preHandler que valida el Bearer JWT y setea
 *   `request.agentId` / `request.agentRole` / `request.agentUsername`.
 *   En fallo lanza DomainError(invalid_token) para que el error handler
 *   global [M10] responda 401 Problem+JSON.
 *
 * El estado bankrupt NO se verifica aquí: se valida en los services de
 * escritura (contrato §11 último punto) — las lecturas autenticadas de un
 * agente quebrado con access token vigente siguen permitidas (§10.14).
 *
 * El plugin lleva el símbolo `skip-override` (el mismo mecanismo que usa
 * fastify-plugin) para que `app.register(authPlugin)` NO cree un contexto de
 * encapsulación: las decoraciones deben quedar en la instancia raíz, visibles
 * para todos los módulos de rutas que registra [M10].
 */
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { domainError } from "../lib/errors";
import type { AgentRole } from "../types/contracts";

async function plugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    // Fijar HS256 explícitamente en firma y verificación (rechaza tokens
    // con otros algoritmos de la misma familia HMAC).
    sign: { algorithm: "HS256" },
    verify: { algorithms: ["HS256"] },
  });

  // Decoraciones de request: optimizan la forma del objeto (hidden class).
  // Los valores por defecto son placeholders: SOLO son válidos tras pasar
  // por `authenticate` (ver src/auth/types.d.ts).
  app.decorateRequest("agentId", "");
  app.decorateRequest("agentRole", "" as unknown as AgentRole);
  app.decorateRequest("agentUsername", "");

  app.decorate(
    "authenticate",
    async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
      try {
        await request.jwtVerify();
      } catch {
        // Header ausente, token malformado, firma inválida o expirado:
        // todos colapsan en invalid_token (401) — sin filtrar detalles.
        throw domainError("invalid_token", "Access token ausente, inválido o expirado.");
      }
      const claims = request.user;
      request.agentId = claims.sub;
      request.agentRole = claims.role;
      request.agentUsername = claims.username;
    },
  );
}

/**
 * Plugin de auth para `app.register(authPlugin)` (o llamada directa
 * `await authPlugin(app)`). No encapsula: decora la instancia del caller.
 */
export const authPlugin: FastifyPluginAsync = Object.assign(plugin, {
  [Symbol.for("skip-override")]: true,
});
