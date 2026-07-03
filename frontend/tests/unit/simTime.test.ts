import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TTL_SIM_SECONDS,
  fmtDurationSeconds,
  realDurationSimHint,
  realToSimSeconds,
  SIM_FACTOR,
  simToRealSeconds,
  TTL_PRESETS,
  ttlEquivalenceHint,
} from "../../src/pages/market/simTime";

describe("conversión sim ↔ real (factor 5×)", () => {
  test("simToRealSeconds divide por el factor", () => {
    expect(SIM_FACTOR).toBe(5);
    expect(simToRealSeconds(3_600)).toBe(720); // 1 h sim ≈ 12 min reales
    expect(simToRealSeconds(60)).toBe(12);
  });

  test("realToSimSeconds multiplica por el factor", () => {
    expect(realToSimSeconds(720)).toBe(3_600);
    expect(realToSimSeconds(3_600)).toBe(18_000); // 1 h real ≈ 5 h sim
  });
});

describe("fmtDurationSeconds", () => {
  test("dos unidades más significativas", () => {
    expect(fmtDurationSeconds(0)).toBe("0 s");
    expect(fmtDurationSeconds(45)).toBe("45 s");
    expect(fmtDurationSeconds(90)).toBe("1 min 30 s");
    expect(fmtDurationSeconds(3_600)).toBe("1 h");
    expect(fmtDurationSeconds(5_400)).toBe("1 h 30 min");
    expect(fmtDurationSeconds(118_800)).toBe("1 d 9 h");
  });
});

describe("presets de TTL simulado (design doc §4.2)", () => {
  test("1 min / 1 h / 1 día / 1 semana simulados", () => {
    expect(TTL_PRESETS.map((p) => p.simSeconds)).toEqual([
      60, 3_600, 86_400, 604_800,
    ]);
    expect(TTL_PRESETS.map((p) => p.simSeconds)).toContain(
      DEFAULT_TTL_SIM_SECONDS,
    );
  });

  test("hint de equivalencia real", () => {
    const hint = ttlEquivalenceHint(3_600);
    expect(hint).toContain("1 h simulados");
    expect(hint).toContain("12 min reales");
    expect(hint).toContain("factor 5×");
  });
});

describe("realDurationSimHint (duraciones REALES de recetas)", () => {
  test("equivale multiplicando por el factor", () => {
    expect(realDurationSimHint(3_600)).toBe("≈ 5 h simuladas (factor 5×)");
  });
});
