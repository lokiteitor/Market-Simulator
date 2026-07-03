import { describe, expect, test } from "bun:test";
import {
  fmtDateTime,
  fmtMoney,
  fmtQty,
  fmtRelative,
  parseMoneyToCents,
  parseQtyToCent,
  truncId,
} from "../../src/lib/format";

describe("fmtMoney", () => {
  test("formatea centavos con $ y millares", () => {
    expect(fmtMoney(123456)).toBe("$1,234.56");
    expect(fmtMoney(25000)).toBe("$250.00");
    expect(fmtMoney(123456789)).toBe("$1,234,567.89");
  });

  test("valores pequeños y cero", () => {
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(5)).toBe("$0.05");
    expect(fmtMoney(99)).toBe("$0.99");
    expect(fmtMoney(100)).toBe("$1.00");
  });

  test("negativos con signo antes del $", () => {
    expect(fmtMoney(-123456)).toBe("-$1,234.56");
    expect(fmtMoney(-5)).toBe("-$0.05");
  });

  test("redondea entradas no enteras", () => {
    expect(fmtMoney(123456.4)).toBe("$1,234.56");
    expect(fmtMoney(123456.6)).toBe("$1,234.57");
  });
});

describe("fmtQty", () => {
  test("formatea centésimas con unidad", () => {
    expect(fmtQty(1250, "kg")).toBe("12.50 kg");
    expect(fmtQty(1500, "kg")).toBe("15.00 kg");
    expect(fmtQty(123456789, "L")).toBe("1,234,567.89 L");
  });

  test("sin unidad omite el sufijo", () => {
    expect(fmtQty(1250)).toBe("12.50");
    expect(fmtQty(0)).toBe("0.00");
  });

  test("valores pequeños y negativos", () => {
    expect(fmtQty(1, "kg")).toBe("0.01 kg");
    expect(fmtQty(-1250, "kg")).toBe("-12.50 kg");
  });
});

describe("truncId", () => {
  test("trunca a 8 caracteres", () => {
    expect(truncId("0198f3a2-7b1c-7def-8a90-123456789abc")).toBe("0198f3a2");
    expect(truncId("0198f3a2")).toBe("0198f3a2");
  });

  test("ids más cortos quedan intactos", () => {
    expect(truncId("abc")).toBe("abc");
    expect(truncId("")).toBe("");
  });
});

describe("fmtDateTime", () => {
  test("devuelve fecha local legible para ISO válido", () => {
    const out = fmtDateTime("2026-07-03T12:34:56Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(5);
    expect(out).toContain("2026");
  });

  test("ISO inválido devuelve em dash", () => {
    expect(fmtDateTime("no-es-fecha")).toBe("—");
    expect(fmtDateTime("")).toBe("—");
  });
});

describe("fmtRelative", () => {
  test("pasado reciente en minutos", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = fmtRelative(iso);
    expect(out).toContain("5");
    expect(out.toLowerCase()).toContain("min");
  });

  test("futuro en horas", () => {
    const iso = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const out = fmtRelative(iso);
    expect(out).toContain("2");
    expect(out.toLowerCase()).toContain("hora");
  });

  test("días para diferencias grandes", () => {
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(fmtRelative(iso).toLowerCase()).toContain("día");
  });

  test("ISO inválido devuelve em dash", () => {
    expect(fmtRelative("garbage")).toBe("—");
  });
});

describe("parseMoneyToCents", () => {
  test("parsea decimales a centavos", () => {
    expect(parseMoneyToCents("1234.56")).toBe(123456);
    expect(parseMoneyToCents("250")).toBe(25000);
    expect(parseMoneyToCents("0.05")).toBe(5);
    expect(parseMoneyToCents("0")).toBe(0);
  });

  test("acepta $ y comas de millares bien agrupadas", () => {
    expect(parseMoneyToCents("$1,234.56")).toBe(123456);
    expect(parseMoneyToCents("$ 250")).toBe(25000);
    expect(parseMoneyToCents("12,345.67")).toBe(1234567);
  });

  test("un solo decimal se interpreta como décimas", () => {
    expect(parseMoneyToCents("12.5")).toBe(1250);
    expect(parseMoneyToCents(".5")).toBe(50);
  });

  test("inválidos devuelven null", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("   ")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("12.345")).toBeNull(); // >2 decimales
    expect(parseMoneyToCents("-5")).toBeNull(); // negativos
    expect(parseMoneyToCents("1,23.45")).toBeNull(); // agrupación inválida
    expect(parseMoneyToCents("1.2.3")).toBeNull();
    expect(parseMoneyToCents("12e3")).toBeNull();
    expect(parseMoneyToCents(".")).toBeNull();
    expect(parseMoneyToCents("$")).toBeNull();
  });
});

describe("parseQtyToCent", () => {
  test("parsea decimales a centésimas", () => {
    expect(parseQtyToCent("15")).toBe(1500);
    expect(parseQtyToCent("12.5")).toBe(1250);
    expect(parseQtyToCent("12.50")).toBe(1250);
    expect(parseQtyToCent("1,500.25")).toBe(150025);
    expect(parseQtyToCent("0.01")).toBe(1);
  });

  test("inválidos devuelven null", () => {
    expect(parseQtyToCent("")).toBeNull();
    expect(parseQtyToCent("kg")).toBeNull();
    expect(parseQtyToCent("1.234")).toBeNull(); // >2 decimales
    expect(parseQtyToCent("-1")).toBeNull();
    expect(parseQtyToCent("1 500")).toBeNull();
    expect(parseQtyToCent("$15")).toBeNull(); // $ solo en dinero
    expect(parseQtyToCent("15,00")).toBeNull(); // coma decimal no soportada
  });
});
