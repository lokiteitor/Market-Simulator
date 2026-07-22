/**
 * Tests unitarios PUROS de src/auth/tokens.ts — [M1 auth]
 * Sin DB ni Redis; config carga con sus defaults de desarrollo.
 */
import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { config } from "../../../src/config";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../../../src/auth/tokens";

function decodeB64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

const AGENT_ID = "01890a5d-ac96-774b-bcce-b302099a8057";

describe("signAccessToken", () => {
  test("produce un JWT HS256 con claims sub/username/role/iat/exp", () => {
    const now = new Date("2026-07-03T12:00:00.000Z");
    const { token, expiresAt } = signAccessToken(
      { agentId: AGENT_ID, username: "alice", role: "trader" },
      now,
    );

    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    const [headerB64, payloadB64, signature] = parts as [string, string, string];

    expect(decodeB64urlJson(headerB64)).toEqual({ alg: "HS256", typ: "JWT" });

    const claims = decodeB64urlJson(payloadB64);
    expect(claims.sub).toBe(AGENT_ID);
    expect(claims.username).toBe("alice");
    expect(claims.role).toBe("trader");
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims.exp).toBe(
      Math.floor(now.getTime() / 1000) + config.accessTokenTtlSeconds,
    );

    // expiresAt del resultado coincide exactamente con el claim exp.
    expect(expiresAt.getTime()).toBe((claims.exp as number) * 1000);

    // Firma verificable con HMAC-SHA256(config.jwtSecret) — lo que hará
    // @fastify/jwt en el plugin.
    const expected = createHmac("sha256", config.jwtSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    expect(signature).toBe(expected);
  });

  test("un secret distinto produce firma distinta (sanidad HS256)", () => {
    const now = new Date("2026-07-03T12:00:00.000Z");
    const { token } = signAccessToken(
      { agentId: AGENT_ID, username: "alice", role: "trader" },
      now,
    );
    const [headerB64, payloadB64, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const forged = createHmac("sha256", "otro-secret")
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    expect(signature).not.toBe(forged);
  });
});

describe("generateRefreshToken / hashRefreshToken", () => {
  test("token de 32 bytes hex, hash SHA-256 hex y expiración por config", () => {
    const now = new Date("2026-07-03T12:00:00.000Z");
    const { token, tokenHash, expiresAt } = generateRefreshToken(now);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(hashRefreshToken(token)).toBe(tokenHash);
    expect(expiresAt.getTime()).toBe(
      now.getTime() + config.refreshTokenTtlSeconds * 1000,
    );
  });

  test("cada token es único y su hash no revela el token", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
    expect(a.tokenHash).not.toBe(a.token);
  });

  test("hashRefreshToken es determinista", () => {
    expect(hashRefreshToken("abc")).toBe(hashRefreshToken("abc"));
    expect(hashRefreshToken("abc")).not.toBe(hashRefreshToken("abd"));
  });
});
