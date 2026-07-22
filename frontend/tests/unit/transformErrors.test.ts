/**
 * transformErrors.test.ts — traducción de códigos de dominio de
 * POST /transformations a mensajes accionables.
 */
import { describe, expect, test } from "bun:test";

import {
  CAPACITY_ERROR_CODES,
  transformationErrorMessage,
} from "../../src/pages/transformations/transformErrors";

describe("transformationErrorMessage", () => {
  test("códigos de dominio conocidos tienen mensaje en español", () => {
    for (const code of [
      "resource_depleted",
      "insufficient_capacity",
      "recipe_capacity_saturated",
      "insufficient_capital",
      "insufficient_inventory",
      "unknown_recipe",
      "agent_bankrupt",
    ]) {
      const msg = transformationErrorMessage(code);
      expect(msg).not.toBeNull();
      expect(msg?.length ?? 0).toBeGreaterThan(10);
    }
  });

  test("código desconocido → null (cae al banner crudo)", () => {
    expect(transformationErrorMessage("totally_new_code")).toBeNull();
    expect(transformationErrorMessage("")).toBeNull();
  });

  test("los códigos de capacidad están mapeados y marcados para resync", () => {
    expect(CAPACITY_ERROR_CODES.has("insufficient_capacity")).toBe(true);
    expect(CAPACITY_ERROR_CODES.has("recipe_capacity_saturated")).toBe(true);
    expect(CAPACITY_ERROR_CODES.has("resource_depleted")).toBe(false);
  });
});
