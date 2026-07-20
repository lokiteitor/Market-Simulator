/**
 * Repositorio de autenticación (contrato §11) — [M1 auth]
 *
 * Credenciales (`agent_credentials`) y refresh tokens (`agent_refresh_token`).
 * Regla §0: recibe `tx` como primer parámetro; las transacciones se abren
 * SOLO en los services con `withTransaction`.
 *
 * Los refresh tokens se guardan SIEMPRE hasheados (SHA-256 hex); aquí nunca
 * entra ni sale un token en claro.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../db";
import {
  agent,
  agentCredentials,
  agentRefreshToken,
  type AgentRefreshTokenRow,
  type AgentRow,
} from "../db/schema";

export interface AgentWithPasswordHash {
  agent: AgentRow;
  passwordHash: string;
}

export const authRepository = {
  /** Inserta las credenciales de un agente recién creado. */
  async insertCredentials(
    tx: Tx,
    p: { agentId: string; passwordHash: string },
  ): Promise<void> {
    await tx.insert(agentCredentials).values({
      agentId: p.agentId,
      passwordHash: p.passwordHash,
    });
  },

  /** Agente por username (para el check de unicidad en register). */
  async findAgentByUsername(tx: Tx, username: string): Promise<AgentRow | null> {
    const rows = await tx
      .select()
      .from(agent)
      .where(eq(agent.username, username))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Agente + hash de contraseña por username (login). */
  async findAgentWithCredentialsByUsername(
    tx: Tx,
    username: string,
  ): Promise<AgentWithPasswordHash | null> {
    const rows = await tx
      .select({ agent, passwordHash: agentCredentials.passwordHash })
      .from(agent)
      .innerJoin(agentCredentials, eq(agentCredentials.agentId, agent.agentId))
      .where(eq(agent.username, username))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Agente por id (refresh: reconstruir claims y validar estado). */
  async findAgentById(tx: Tx, agentId: string): Promise<AgentRow | null> {
    const rows = await tx
      .select()
      .from(agent)
      .where(eq(agent.agentId, agentId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Persiste un refresh token (hash) y devuelve su token_id. */
  async insertRefreshToken(
    tx: Tx,
    p: { agentId: string; tokenHash: string; expiresAt: Date },
  ): Promise<string> {
    const rows = await tx
      .insert(agentRefreshToken)
      .values({
        agentId: p.agentId,
        tokenHash: p.tokenHash,
        expiresAt: p.expiresAt,
      })
      .returning({ tokenId: agentRefreshToken.tokenId });
    const row = rows[0];
    if (row === undefined) {
      throw new Error("agent_refresh_token insert returned no rows");
    }
    return row.tokenId;
  },

  /**
   * Refresh token VIGENTE por hash: `revoked_at IS NULL AND expires_at > now()`.
   * `FOR UPDATE` serializa rotaciones concurrentes del mismo token: la segunda
   * tx espera el lock y, al re-evaluar el predicado sobre la fila ya revocada,
   * no encuentra nada ⇒ 401 (un refresh token se usa exactamente una vez).
   */
  async findActiveRefreshTokenByHash(
    tx: Tx,
    tokenHash: string,
  ): Promise<AgentRefreshTokenRow | null> {
    const rows = await tx
      .select()
      .from(agentRefreshToken)
      .where(
        and(
          eq(agentRefreshToken.tokenHash, tokenHash),
          isNull(agentRefreshToken.revokedAt),
          sql`${agentRefreshToken.expiresAt} > now()`,
        ),
      )
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  },

  /** Revoca un token por id (rotación). Devuelve # de filas revocadas (0|1). */
  async revokeById(tx: Tx, tokenId: string): Promise<number> {
    const rows = await tx
      .update(agentRefreshToken)
      .set({ revokedAt: sql`now()` })
      .where(
        and(eq(agentRefreshToken.tokenId, tokenId), isNull(agentRefreshToken.revokedAt)),
      )
      .returning({ tokenId: agentRefreshToken.tokenId });
    return rows.length;
  },

  /**
   * Revoca por hash acotado al agente dueño (logout: un agente solo puede
   * revocar sus propios tokens). Devuelve # de filas revocadas (0|1).
   */
  async revokeByHashForAgent(
    tx: Tx,
    p: { agentId: string; tokenHash: string },
  ): Promise<number> {
    const rows = await tx
      .update(agentRefreshToken)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(agentRefreshToken.tokenHash, p.tokenHash),
          eq(agentRefreshToken.agentId, p.agentId),
          isNull(agentRefreshToken.revokedAt),
        ),
      )
      .returning({ tokenId: agentRefreshToken.tokenId });
    return rows.length;
  },

  /** Revoca TODOS los refresh tokens vivos del agente (quiebra, §10.13). */
  async revokeAllForAgent(tx: Tx, agentId: string): Promise<number> {
    const rows = await tx
      .update(agentRefreshToken)
      .set({ revokedAt: sql`now()` })
      .where(
        and(eq(agentRefreshToken.agentId, agentId), isNull(agentRefreshToken.revokedAt)),
      )
      .returning({ tokenId: agentRefreshToken.tokenId });
    return rows.length;
  },
};
