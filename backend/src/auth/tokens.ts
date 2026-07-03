/**
 * Emisión de tokens (contrato §11) — [M1 auth]
 *
 * - Access token: JWT HS256 firmado con `config.jwtSecret`.
 *   Claims: `sub` = agent_id, `username`, `role`, `iat`, `exp`
 *   (`exp = iat + config.accessTokenTtlSeconds`). Es stateless: la
 *   verificación la hace @fastify/jwt en `src/auth/plugin.ts`.
 *   La firma se implementa aquí con node:crypto (HMAC-SHA256 sobre
 *   `base64url(header).base64url(payload)`), 100% compatible con la
 *   verificación de @fastify/jwt y sin dependencia de la instancia Fastify
 *   (los services emiten tokens fuera del ciclo request/reply).
 *
 * - Refresh token: 32 bytes aleatorios en hex (64 chars). NUNCA se persiste
 *   en claro: en DB va su SHA-256 hex (`agent_refresh_token.token_hash`).
 *   Expira a los `config.refreshTokenTtlSeconds` segundos REALES (los TTLs
 *   de auth no son tiempo simulado).
 *
 * Módulo puro (sin I/O): testeable en tests/unit/auth.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { config } from "../config";
import type { AgentRole } from "../types/contracts";

/** Claims que firma el emisor (los que van en `payload` de jwtSign). */
export interface AccessTokenPayload {
  /** agent_id (UUID). */
  sub: string;
  username: string;
  role: AgentRole;
}

/** Claims completos tal como llegan verificados en `request.user`. */
export interface AccessTokenClaims extends AccessTokenPayload {
  /** Epoch seconds. */
  iat: number;
  /** Epoch seconds. */
  exp: number;
}

export interface AccessToken {
  token: string;
  /** Instante exacto de expiración (== claim `exp` en ms). */
  expiresAt: Date;
}

export interface RefreshToken {
  /** Valor en claro que se entrega al cliente (64 chars hex). */
  token: string;
  /** SHA-256 hex del token: lo ÚNICO que se persiste. */
  tokenHash: string;
  expiresAt: Date;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Firma un access token JWT HS256 con los claims del contrato §11.
 * `now` es inyectable para tests; default reloj real.
 */
export function signAccessToken(
  p: { agentId: string; username: string; role: AgentRole },
  now: Date = new Date(),
): AccessToken {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + config.accessTokenTtlSeconds;
  const claims: AccessTokenClaims = {
    sub: p.agentId,
    username: p.username,
    role: p.role,
    iat,
    exp,
  };
  const signingInput = `${base64urlJson({ alg: "HS256", typ: "JWT" })}.${base64urlJson(claims)}`;
  const signature = createHmac("sha256", config.jwtSecret)
    .update(signingInput)
    .digest("base64url");
  return {
    token: `${signingInput}.${signature}`,
    // exp está truncado a segundos: el instante devuelto coincide con el claim.
    expiresAt: new Date(exp * 1000),
  };
}

/** SHA-256 hex de un refresh token (forma persistida en `token_hash`). */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Genera un refresh token nuevo: 32 bytes aleatorios (hex) + su hash +
 * expiración a `config.refreshTokenTtlSeconds` segundos reales de `now`.
 */
export function generateRefreshToken(now: Date = new Date()): RefreshToken {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(now.getTime() + config.refreshTokenTtlSeconds * 1000),
  };
}
