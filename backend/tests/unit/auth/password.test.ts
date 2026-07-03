/**
 * Tests unitarios PUROS de src/auth/password.ts — [M1 auth]
 * Sin DB ni Redis. Argon2id con los parámetros del contrato §1.
 */
import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../../../src/auth/password";

describe("hashPassword / verifyPassword", () => {
  test("hash argon2id (formato PHC) y verificación correcta", async () => {
    const hash = await hashPassword("contraseña-super-segura-123");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    // Parámetros del contrato §1: memoryCost 19456, timeCost 2.
    expect(hash).toContain("m=19456");
    expect(hash).toContain("t=2");
    await expect(verifyPassword("contraseña-super-segura-123", hash)).resolves.toBe(true);
  });

  test("contraseña incorrecta ⇒ false", async () => {
    const hash = await hashPassword("contraseña-super-segura-123");
    await expect(verifyPassword("otra-contraseña-000", hash)).resolves.toBe(false);
  });

  test("hash corrupto ⇒ false (no lanza)", async () => {
    await expect(verifyPassword("lo-que-sea", "no-es-un-hash-phc")).resolves.toBe(false);
  });

  test("mismo password ⇒ hashes distintos (salt aleatoria)", async () => {
    const [a, b] = await Promise.all([
      hashPassword("contraseña-super-segura-123"),
      hashPassword("contraseña-super-segura-123"),
    ]);
    expect(a).not.toBe(b);
  });
});
