/**
 * Tests de la lógica pura de validación del formulario de auth [FE4]
 * (src/pages/auth/validation.ts): reglas de RegisterAgentRequest del
 * openapi y reparto de Problem RFC 7807 en errores por campo + banner.
 */
import { describe, expect, test } from "bun:test";

import type { Problem } from "../../src/api/types";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  splitProblemByField,
  USERNAME_MAX,
  USERNAME_MIN,
  validatePassword,
  validateUsername,
} from "../../src/pages/auth/validation";

// ---------------------------------------------------------------------------
// validateUsername (openapi: minLength 3, maxLength 64, ^[a-zA-Z0-9_.-]+$)
// ---------------------------------------------------------------------------

describe("validateUsername", () => {
  test("acepta usernames válidos del patrón del openapi", () => {
    expect(validateUsername("ana")).toBeNull();
    expect(validateUsername("agente_1.trader-X")).toBeNull();
    expect(validateUsername("a".repeat(USERNAME_MAX))).toBeNull();
  });

  test("rechaza vacío", () => {
    expect(validateUsername("")).not.toBeNull();
  });

  test("rechaza por longitud mínima y máxima", () => {
    expect(validateUsername("a".repeat(USERNAME_MIN - 1))).not.toBeNull();
    expect(validateUsername("a".repeat(USERNAME_MAX + 1))).not.toBeNull();
  });

  test("rechaza caracteres fuera del patrón", () => {
    expect(validateUsername("con espacio")).not.toBeNull();
    expect(validateUsername("acento_á")).not.toBeNull();
    expect(validateUsername("emoji🌱")).not.toBeNull();
    expect(validateUsername("con/slash")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validatePassword (openapi: minLength 12, maxLength 256)
// ---------------------------------------------------------------------------

describe("validatePassword", () => {
  test("acepta contraseñas dentro de rango", () => {
    expect(validatePassword("a".repeat(PASSWORD_MIN))).toBeNull();
    expect(validatePassword("a".repeat(PASSWORD_MAX))).toBeNull();
    expect(validatePassword("frase larga con espacios ✓✓")).toBeNull();
  });

  test("rechaza vacía y corta", () => {
    expect(validatePassword("")).not.toBeNull();
    expect(validatePassword("a".repeat(PASSWORD_MIN - 1))).not.toBeNull();
  });

  test("rechaza por encima del máximo", () => {
    expect(validatePassword("a".repeat(PASSWORD_MAX + 1))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// splitProblemByField (Problem RFC 7807 → inline por campo + banner)
// ---------------------------------------------------------------------------

const KNOWN = ["username", "password", "role"] as const;

function problemWith(errors: Problem["errors"]): Problem {
  const p: Problem = {
    type: "https://errors.mercado-agricola/validation",
    title: "Petición inválida",
    status: 422,
  };
  if (errors !== undefined) p.errors = errors;
  return p;
}

describe("splitProblemByField", () => {
  test("mapea errores con field conocido y no deja banner si todo quedó inline", () => {
    const problem = problemWith([
      { code: "too_short", field: "password", message: "Muy corta" },
      { code: "taken", field: "username", message: "Ya en uso" },
    ]);
    const { fields, general } = splitProblemByField(problem, KNOWN);
    expect(fields["password"]).toBe("Muy corta");
    expect(fields["username"]).toBe("Ya en uso");
    expect(general).toBeNull();
  });

  test("el primer error por campo gana", () => {
    const problem = problemWith([
      { code: "a", field: "username", message: "primero" },
      { code: "b", field: "username", message: "segundo" },
    ]);
    const { fields, general } = splitProblemByField(problem, KNOWN);
    expect(fields["username"]).toBe("primero");
    // El duplicado no mapeado queda para el banner.
    expect(general?.errors?.map((e) => e.message)).toEqual(["segundo"]);
  });

  test("errores sin field o con field desconocido van al banner", () => {
    const problem = problemWith([
      { code: "global", field: null, message: "Error global" },
      { code: "other", field: "ttl_seconds", message: "Campo ajeno" },
      { code: "ok", field: "role", message: "Rol inválido" },
    ]);
    const { fields, general } = splitProblemByField(problem, KNOWN);
    expect(fields["role"]).toBe("Rol inválido");
    expect(general).not.toBeNull();
    expect(general?.errors?.map((e) => e.code)).toEqual(["global", "other"]);
    expect(general?.title).toBe("Petición inválida");
  });

  test("Problem sin errors[] queda entero como banner", () => {
    const problem = problemWith(undefined);
    const { fields, general } = splitProblemByField(problem, KNOWN);
    expect(Object.keys(fields)).toHaveLength(0);
    expect(general).toEqual(problem);
    expect(general?.errors).toBeUndefined();
  });

  test("no muta el Problem original", () => {
    const problem = problemWith([
      { code: "a", field: "username", message: "inline" },
      { code: "b", field: null, message: "banner" },
    ]);
    const before = JSON.parse(JSON.stringify(problem)) as Problem;
    splitProblemByField(problem, KNOWN);
    expect(problem).toEqual(before);
  });
});
