/**
 * validation.ts — Validación client-side del formulario de auth [FE4]
 * (reglas de `RegisterAgentRequest` en specs/openapi.yaml) y reparto de un
 * `Problem` RFC 7807 en errores inline por campo + resto para banner.
 *
 * Lógica pura, sin React: testeable con `bun test`.
 */
import type { Problem, ProblemFieldError } from "../../api/types";

// ---------------------------------------------------------------------------
// Reglas del openapi (RegisterAgentRequest)
// ---------------------------------------------------------------------------

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 64;
/** Patrón del openapi: `^[a-zA-Z0-9_.-]+$`. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/**
 * Valida un username para REGISTRO según el openapi.
 * Devuelve el mensaje de error (es) o null si es válido.
 */
export function validateUsername(value: string): string | null {
  if (value === "") return "Escribe un nombre de usuario.";
  if (value.length < USERNAME_MIN) {
    return `El nombre de usuario debe tener al menos ${USERNAME_MIN} caracteres.`;
  }
  if (value.length > USERNAME_MAX) {
    return `El nombre de usuario no puede superar ${USERNAME_MAX} caracteres.`;
  }
  if (!USERNAME_PATTERN.test(value)) {
    return "Solo se permiten letras, números y los símbolos . _ - (sin espacios).";
  }
  return null;
}

/**
 * Valida una contraseña para REGISTRO según el openapi.
 * Devuelve el mensaje de error (es) o null si es válida.
 */
export function validatePassword(value: string): string | null {
  if (value === "") return "Escribe una contraseña.";
  if (value.length < PASSWORD_MIN) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
  }
  if (value.length > PASSWORD_MAX) {
    return `La contraseña no puede superar ${PASSWORD_MAX} caracteres.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Problem → errores por campo + resto (banner)
// ---------------------------------------------------------------------------

export interface ProblemSplit {
  /** Mensajes mapeados por nombre de campo del request (primer error gana). */
  fields: Record<string, string>;
  /**
   * Problem restante para un banner general: el original sin los errores ya
   * mapeados a campos. `null` si TODO quedó mapeado inline.
   */
  general: Problem | null;
}

/**
 * Reparte un `Problem` (422 de dominio, etc.) entre errores inline por campo
 * (`errors[].field` ∈ `knownFields`) y un Problem residual para banner.
 */
export function splitProblemByField(
  problem: Problem,
  knownFields: readonly string[],
): ProblemSplit {
  const fields: Record<string, string> = {};
  const leftovers: ProblemFieldError[] = [];

  for (const err of problem.errors ?? []) {
    const field = err.field ?? null;
    if (field !== null && knownFields.includes(field) && fields[field] === undefined) {
      fields[field] = err.message;
    } else {
      leftovers.push(err);
    }
  }

  if (Object.keys(fields).length > 0 && leftovers.length === 0) {
    return { fields, general: null };
  }

  const general: Problem = { ...problem };
  if (leftovers.length > 0) general.errors = leftovers;
  else delete general.errors;
  return { fields, general };
}
