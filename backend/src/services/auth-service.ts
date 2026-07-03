/**
 * Servicio de autenticación (contrato §11) — [M1 auth]
 *
 * Flujos: register, login, refresh (rotación), logout, y
 * `revokeAllForAgent` (consumido por [M2] al aplicar quiebras, §10.13).
 *
 * Coordinación de eventos/notificaciones en register (§10.12):
 *  - `appendEvent(agent_registered)` lo hace `agentRegistrar.createAgent`
 *    [M2] DENTRO de la misma transacción.
 *  - El broadcast `agent_joined` lo publica ESTE service post-commit.
 */
import { withTransaction, type Tx } from "../db";
import { domainError } from "../lib/errors";
import { publishBroadcast } from "../notifier";
import { logger } from "../observability/logger";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../auth/tokens";
import { authRepository } from "../repositories/auth-repository";
import { agentRegistrar } from "./agent-service";
import type { AgentRole, AgentRow } from "../types/contracts";

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
 */
function translateUniqueUsername(err: unknown, username: string): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505" &&
    String((err as { constraint_name?: unknown }).constraint_name ?? "").includes("username")
  ) {
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

  // Post-commit (§0/§10.12): broadcast agent_joined. Un fallo del notifier no
  // debe fallar el registro ya commiteado — se loguea y se sigue.
  try {
    await publishBroadcast({
      type: "agent_joined",
      occurred_at: new Date().toISOString(),
      payload: {
        agent_id: committed.agentRow.agentId,
        username: committed.agentRow.username,
        role: committed.agentRow.role,
      },
    });
  } catch (err) {
    logger.warn(
      { err, agentId: committed.agentRow.agentId },
      "register: fallo publicando broadcast agent_joined post-commit",
    );
  }

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
