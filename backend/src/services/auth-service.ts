/**
 * Servicio de autenticación (contrato §11) — [M1 auth]
 *
 * Flujos: register, login, refresh (rotación), logout, y
 * `revokeAllForAgent` (consumido por [M2] al aplicar quiebras, §10.13).
 *
 * Coordinación de eventos en register (§10.12):
 *  - `appendEvent(agent_registered)` lo hace `agentRegistrar.createAgent`
 *    [M2] DENTRO de la misma transacción.
 */
import { withTransaction, type Tx } from "../db";
import { domainError } from "../lib/errors";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../auth/tokens";
import { authRepository } from "../repositories/auth-repository";
import { agentRegistrar } from "./agent-service";
import type { AgentRole, AgentRow } from "../types/contracts";
import { Queue } from "bullmq";
import { GOLD_ISSUANCE_QUEUE, bullmqConnectionOptions } from "../workers/queues";

let goldIssuanceQueue: Queue<{ agentId: string }> | null = null;

function getGoldIssuanceQueue(): Queue<{ agentId: string }> {
  if (goldIssuanceQueue === null) {
    goldIssuanceQueue = new Queue<{ agentId: string }>(GOLD_ISSUANCE_QUEUE, {
      connection: bullmqConnectionOptions(),
    });
  }
  return goldIssuanceQueue;
}

// ---------------------------------------------------------------------------
// Tipos de resultado
// ---------------------------------------------------------------------------

export interface TokenPairResult {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface RegisterResult extends TokenPairResult {
  agent: AgentRow;
  /** Capacidades instaladas por el registrar (running = 0 por construcción). */
  capacities: Array<{ recipeId: string; installations: number }>;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function invalidCredentials(): never {
  // Mensaje único para username inexistente y contraseña incorrecta:
  // no filtrar cuál de los dos falló (anti-enumeración de usuarios).
  throw domainError("invalid_credentials", "Usuario o contraseña incorrectos.");
}

function invalidToken(): never {
  throw domainError(
    "invalid_token",
    "Refresh token desconocido, expirado o revocado.",
  );
}

// Hash señuelo para igualar el timing del login cuando el username no existe
// (se ejecuta un verify argon2id de costo equivalente). Lazy: se computa una
// sola vez en el primer login fallido por username.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("timing-equalizer-dummy-password");
  return dummyHashPromise;
}

/**
 * Traduce la unique violation de Postgres (23505 sobre agent.username) a
 * username_taken: cubre la carrera entre el check explícito y el INSERT de
 * dos registros concurrentes con el mismo username.
 *
 * drizzle-orm (>= 0.4x, driver postgres-js) envuelve el PostgresError del
 * driver en un DrizzleQueryError dejando el original en `cause`, así que se
 * inspecciona primero la causa desenvuelta; el propio `err` queda como
 * fallback por si drizzle dejara de envolver.
 */
function isUsernameUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "23505" &&
    String((e as { constraint_name?: unknown }).constraint_name ?? "").includes("username")
  );
}

function translateUniqueUsername(err: unknown, username: string): unknown {
  const cause: unknown =
    typeof err === "object" && err !== null && "cause" in err
      ? (err as { cause?: unknown }).cause
      : undefined;
  const pg: unknown = cause ? cause : err;
  if (isUsernameUniqueViolation(pg) || isUsernameUniqueViolation(err)) {
    return domainError(
      "username_taken",
      `El nombre de usuario "${username}" ya está en uso.`,
      { field: "username" },
    );
  }
  return err;
}

// ---------------------------------------------------------------------------
// Flujos
// ---------------------------------------------------------------------------

async function register(p: {
  username: string;
  password: string;
  role: AgentRole;
}): Promise<RegisterResult> {
  // argon2id es costoso (~decenas de ms): hashear FUERA de la transacción.
  const passwordHash = await hashPassword(p.password);
  const refresh = generateRefreshToken();

  let committed: {
    agentRow: AgentRow;
    capacities: Array<{ recipeId: string; installations: number }>;
  };
  try {
    committed = await withTransaction(async (tx) => {
      const existing = await authRepository.findAgentByUsername(tx, p.username);
      if (existing !== null) {
        throw domainError(
          "username_taken",
          `El nombre de usuario "${p.username}" ya está en uso.`,
          { field: "username" },
        );
      }
      // createAgent [M2]: agent + capacidades del rol + capital semilla
      // (§10.12) + appendEvent(agent_registered) DENTRO de esta tx.
      const agentRow = await agentRegistrar.createAgent(tx, {
        username: p.username,
        role: p.role,
      });
      await authRepository.insertCredentials(tx, {
        agentId: agentRow.agentId,
        passwordHash,
      });
      await authRepository.insertRefreshToken(tx, {
        agentId: agentRow.agentId,
        tokenHash: refresh.tokenHash,
        expiresAt: refresh.expiresAt,
      });
      const capacities = await authRepository.findCapacitiesForAgent(
        tx,
        agentRow.agentId,
      );
      return { agentRow, capacities };
    });
  } catch (err) {
    throw translateUniqueUsername(err, p.username);
  }

  getGoldIssuanceQueue().add(
    "fund-agent",
    { agentId: committed.agentRow.agentId },
    { removeOnComplete: true, removeOnFail: true }
  ).catch((err) => {
    console.error("Error al encolar gold-issuance job:", err);
  });

  const access = signAccessToken({
    agentId: committed.agentRow.agentId,
    username: committed.agentRow.username,
    role: committed.agentRow.role,
  });
  return {
    agent: committed.agentRow,
    capacities: committed.capacities,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

async function login(p: {
  username: string;
  password: string;
}): Promise<TokenPairResult> {
  const found = await withTransaction((tx) =>
    authRepository.findAgentWithCredentialsByUsername(tx, p.username),
  );
  if (found === null) {
    // Verify señuelo para no delatar por timing que el username no existe.
    await verifyPassword(p.password, await getDummyHash());
    invalidCredentials();
  }
  const ok = await verifyPassword(p.password, found.passwordHash);
  if (!ok) invalidCredentials();
  if (found.agent.status === "bankrupt") {
    throw domainError(
      "agent_bankrupt",
      "El agente está en quiebra y no puede iniciar sesión.",
    );
  }

  const refresh = generateRefreshToken();
  await withTransaction((tx) =>
    authRepository.insertRefreshToken(tx, {
      agentId: found.agent.agentId,
      tokenHash: refresh.tokenHash,
      expiresAt: refresh.expiresAt,
    }),
  );

  const access = signAccessToken({
    agentId: found.agent.agentId,
    username: found.agent.username,
    role: found.agent.role,
  });
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

async function refresh(p: { refreshToken: string }): Promise<TokenPairResult> {
  const tokenHash = hashRefreshToken(p.refreshToken);
  const next = generateRefreshToken();

  const agentRow = await withTransaction(async (tx) => {
    const row = await authRepository.findActiveRefreshTokenByHash(tx, tokenHash);
    if (row === null) invalidToken();
    const owner = await authRepository.findAgentById(tx, row.agentId);
    // Defensa en profundidad: al quebrar se revocan todos los tokens
    // (§10.13), así que un token vigente de un bankrupt no debería existir;
    // si existiera, se trata como inválido (openapi /auth/refresh: solo 401).
    if (owner === null || owner.status === "bankrupt") invalidToken();
    // ROTACIÓN: el token usado se revoca y se emite un par nuevo, atómico.
    await authRepository.revokeById(tx, row.tokenId);
    await authRepository.insertRefreshToken(tx, {
      agentId: owner.agentId,
      tokenHash: next.tokenHash,
      expiresAt: next.expiresAt,
    });
    return owner;
  });

  const access = signAccessToken({
    agentId: agentRow.agentId,
    username: agentRow.username,
    role: agentRow.role,
  });
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: next.token,
    refreshExpiresAt: next.expiresAt,
  };
}

/**
 * Revoca el refresh token entregado (logout). Idempotente: si el token no
 * existe, ya estaba revocado o pertenece a OTRO agente, no hace nada — el
 * endpoint responde 204 igualmente (revocar dos veces no es un error y no
 * se filtra la existencia de tokens ajenos).
 */
async function logout(p: { agentId: string; refreshToken: string }): Promise<void> {
  const tokenHash = hashRefreshToken(p.refreshToken);
  await withTransaction((tx) =>
    authRepository.revokeByHashForAgent(tx, { agentId: p.agentId, tokenHash }),
  );
}

/**
 * Revoca TODOS los refresh tokens vivos del agente DENTRO de la tx dada.
 * Lo consume [M2] al aplicar una quiebra (§10.13). Devuelve # revocados.
 */
export async function revokeAllForAgent(tx: Tx, agentId: string): Promise<number> {
  return authRepository.revokeAllForAgent(tx, agentId);
}

export const authService = {
  register,
  login,
  refresh,
  logout,
  revokeAllForAgent,
};
