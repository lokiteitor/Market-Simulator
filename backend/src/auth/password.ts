/**
 * Hash y verificación de contraseñas (contrato §1/§11) — [M1 auth]
 *
 * `Bun.password` con argon2id (memoryCost 19456 KiB, timeCost 2) — SIN
 * dependencia argon2 nativa. El hash resultante (formato PHC
 * `$argon2id$...`) se persiste en `agent_credentials.password_hash` y
 * autodescribe sus parámetros, por lo que la verificación no necesita
 * conocerlos.
 */

const ARGON2ID_OPTIONS = {
  algorithm: "argon2id",
  memoryCost: 19456, // KiB
  timeCost: 2,
} as const;

/** Hashea una contraseña en claro con argon2id. */
export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, ARGON2ID_OPTIONS);
}

/**
 * Verifica una contraseña contra su hash PHC. Devuelve `false` también si
 * el hash almacenado está corrupto/es de un formato desconocido (en vez de
 * propagar el error del verificador): para el cliente es indistinguible de
 * credenciales inválidas.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}
