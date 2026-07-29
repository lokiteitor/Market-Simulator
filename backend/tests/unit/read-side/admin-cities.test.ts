/**
 * Tests unitarios PUROS del panel de ciudades (GET /admin/cities, ADR-020/025):
 * schemas Zod y el mapper `toAdminCitiesDto`. Sin DB.
 */
import { describe, expect, test } from "bun:test";

import { toAdminCitiesDto } from "../../../src/controllers/admin-controller";
import {
  AdminAgentItemSchema,
  AdminAgentsQuerySchema,
  AdminCitiesSchema,
} from "../../../src/schemas/admin";
import type { AdminCities } from "../../../src/services/admin-service";

const UUID_A = "01890000-0000-7000-8000-000000000001";
const UUID_B = "01890000-0000-7000-8000-000000000002";

const cityView = (over: Partial<AdminCities["cities"][number]> = {}) => ({
  agentId: UUID_A,
  username: "madrid",
  status: "active",
  population: 1000,
  capitalAvailableCents: 100_00,
  capitalReservedCents: 5_00,
  ...over,
});

describe("toAdminCitiesDto", () => {
  test("pliega el desglose wage/tax y agrega totales", () => {
    const dto = toAdminCitiesDto({
      cities: [cityView(), cityView({ agentId: UUID_B, username: "tokio", population: 1400 })],
      pendingBySource: [
        { source: "wage", cents: 700 },
        { source: "tax", cents: 300 },
      ],
      distributed: { totalCents: 12_345, sweeps: 4 },
    });

    expect(dto.city_count).toBe(2);
    expect(dto.total_population).toBe(2400);
    expect(dto.pending_income_cents).toBe(1000);
    expect(dto.pending_income_by_source).toEqual({ wage_cents: 700, tax_cents: 300 });
    expect(dto.distributed_income_24h_cents).toBe(12_345);
    expect(dto.distributions_24h).toBe(4);
    // El DTO resultante debe validar contra el schema de la respuesta.
    expect(AdminCitiesSchema.parse(dto)).toEqual(dto);
  });

  test("fuentes ausentes en el ledger cuentan como 0", () => {
    const dto = toAdminCitiesDto({
      cities: [],
      pendingBySource: [{ source: "wage", cents: 42 }],
      distributed: { totalCents: 0, sweeps: 0 },
    });
    expect(dto.pending_income_by_source).toEqual({ wage_cents: 42, tax_cents: 0 });
    expect(dto.pending_income_cents).toBe(42);
    expect(dto.city_count).toBe(0);
    expect(dto.total_population).toBe(0);
  });
});

describe("AdminCitiesSchema", () => {
  test("rechaza importes negativos y población negativa", () => {
    const valid = toAdminCitiesDto({
      cities: [cityView()],
      pendingBySource: [],
      distributed: { totalCents: 0, sweeps: 0 },
    });
    expect(() =>
      AdminCitiesSchema.parse({ ...valid, distributed_income_24h_cents: -1 }),
    ).toThrow();
    expect(() =>
      AdminCitiesSchema.parse({
        ...valid,
        cities: [{ ...valid.cities[0], population: -1 }],
      }),
    ).toThrow();
  });

  test("acepta población 0 (ADR-029: es mutable y puede tocar su suelo)", () => {
    const valid = toAdminCitiesDto({
      cities: [cityView({ population: 0 })],
      pendingBySource: [],
      distributed: { totalCents: 0, sweeps: 0 },
    });
    expect(AdminCitiesSchema.parse(valid).cities[0]?.population).toBe(0);
  });
});

describe("AdminAgentItemSchema (population, ADR-029)", () => {
  const base = {
    agent_id: UUID_A,
    username: "bot-1",
    role: "transformer",
    status: "active",
    capital_available_cents: 0,
    capital_reserved_cents: 0,
    registered_at: "2026-07-01T00:00:00.000Z",
  };

  test("null para roles no-city y entero >= 0 para ciudades", () => {
    expect(AdminAgentItemSchema.parse({ ...base, population: null }).population).toBeNull();
    expect(
      AdminAgentItemSchema.parse({ ...base, role: "city", population: 1000 }).population,
    ).toBe(1000);
    // 0 es admisible: la población es mutable y su suelo puede configurarse en 0.
    expect(AdminAgentItemSchema.parse({ ...base, role: "city", population: 0 }).population).toBe(0);
    expect(() => AdminAgentItemSchema.parse({ ...base, population: -1 })).toThrow();
  });
});

describe("AdminAgentsQuerySchema (filtro de rol)", () => {
  test("acepta los roles sembrables de mercado, incluida `city`", () => {
    expect(AdminAgentsQuerySchema.parse({ role: "city" }).role).toBe("city");
    expect(AdminAgentsQuerySchema.parse({ role: "trader" }).role).toBe("trader");
    expect(() => AdminAgentsQuerySchema.parse({ role: "bank" })).toThrow();
  });
});
