/**
 * Tests puros del cálculo de la cesta urbana (ADR-029), sin DB.
 *
 * Dos propiedades a proteger:
 *
 *  1. El presupuesto per cápita se reparte en DINERO y no en unidades. Si se
 *     repartiera en unidades, un `automovil` (575.004 ¢) y un `pan` (190 ¢)
 *     generarían la misma demanda y el gasto urbano se lo comerían los bienes
 *     caros, dejando la comida como ruido.
 *
 *  2. El RESIDUO del redondeo se acumula entre pasadas. La necesidad se calcula
 *     como diferencia de dos acumulados enteros justo por esto: con un `floor`
 *     por pasada, un producto solo se consumiría si su coste bajase de unos
 *     cientos de céntimos, así que la mayoría de los bienes finales tendrían
 *     demanda urbana CERO para siempre y sus cadenas se quedarían sin salida.
 */
import { describe, expect, test } from "bun:test";
import { cityNeeds, type BasketItem } from "../../../src/services/city-consumption-service";

/** Precios reales del catálogo, para que los números signifiquen algo. */
const PAN = { productId: "pan", referenceCostCents: 190 };
const AUTOMOVIL = { productId: "automovil", referenceCostCents: 575_004 };
/** Presupuesto por habitante y hora simulada (el default del .env). */
const B = 20;

const needOf = (needs: ReturnType<typeof cityNeeds>, id: string): number =>
  needs.find((n) => n.productId === id)?.qtyCent ?? 0;

/** Habitante-segundos de `population` habitantes durante `simSeconds`. */
const popSecs = (population: number, simSeconds: number): number => population * simSeconds;

describe("cityNeeds — reparto en dinero", () => {
  test("reparte el presupuesto a partes iguales EN DINERO entre la cesta", () => {
    // 1000 hab durante 1 hora simulada = 3,6e6 habitante-segundos.
    // Presupuesto: 1000 × 20 = 20.000 ¢/h-sim, 10.000 ¢ para cada producto.
    //   pan:       10.000/190     = 52,6 unidades → 5.263 qty_cent
    //   automovil: 10.000/575.004 = 0,017 unidades → 1 qty_cent
    const needs = cityNeeds(0, popSecs(1000, 3600), [PAN, AUTOMOVIL], B);
    expect(needOf(needs, "pan")).toBe(5263);
    expect(needOf(needs, "automovil")).toBe(1);

    // Lo que importa: el gasto implícito es el MISMO en ambos, no el número de
    // unidades.
    const gastoPan = (needOf(needs, "pan") * PAN.referenceCostCents) / 100;
    expect(gastoPan).toBeLessThanOrEqual(10_000);
    expect(gastoPan).toBeGreaterThan(9_900);
  });

  test("escala linealmente con la población (misma duración)", () => {
    const mil = cityNeeds(0, popSecs(1_000, 3600), [PAN], B);
    const diezMil = cityNeeds(0, popSecs(10_000, 3600), [PAN], B);
    // La proporción se conserva salvo el céntimo del floor.
    expect(needOf(diezMil, "pan") / needOf(mil, "pan")).toBeCloseTo(10, 3);
  });

  test("escala linealmente con el Δt simulado", () => {
    const unaHora = cityNeeds(0, popSecs(1000, 3600), [PAN], B);
    const dosHoras = cityNeeds(0, popSecs(1000, 7200), [PAN], B);
    expect(needOf(dosHoras, "pan") / needOf(unaHora, "pan")).toBeCloseTo(2, 3);
  });

  test("añadir productos a la cesta DILUYE la demanda de los demás", () => {
    // Consecuencia deliberada del reparto a partes iguales, y la razón de que
    // ampliar el catálogo de consumo final tenga un coste económico.
    const dos = cityNeeds(0, popSecs(1000, 3600), [PAN, AUTOMOVIL], B);
    const cuatro = cityNeeds(
      0,
      popSecs(1000, 3600),
      [
        PAN,
        AUTOMOVIL,
        { productId: "x", referenceCostCents: 100 },
        { productId: "y", referenceCostCents: 100 },
      ],
      B,
    );
    expect(needOf(cuatro, "pan")).toBe(Math.floor(needOf(dos, "pan") / 2));
  });
});

describe("cityNeeds — acumulación del residuo", () => {
  /** Cesta realista: 48 productos, el mismo tamaño que la del catálogo. */
  const cesta48: BasketItem[] = [
    PAN,
    AUTOMOVIL,
    ...Array.from({ length: 46 }, (_, i) => ({
      productId: `p${i}`,
      referenceCostCents: 1000 + i,
    })),
  ];
  /** Una pasada del sweeper: 10 s reales × SIM_TIME_FACTOR 5 = 50 s simulados. */
  const PASO = popSecs(1000, 50);

  test("un bien CARO acaba demandándose tras suficientes pasadas", () => {
    // Esta es la propiedad que el modelo anterior (floor por pasada) NO tenía:
    // el automóvil daba 0 en cada pasada y por tanto 0 para siempre.
    let s = 0;
    let acumulado = 0;
    for (let pasada = 0; pasada < 2000; pasada += 1) {
      acumulado += needOf(cityNeeds(s, s + PASO, cesta48, B), "automovil");
      s += PASO;
    }
    expect(acumulado).toBeGreaterThan(0);
  });

  test("la suma de las pasadas coincide con el acumulado de una sola (sin pérdida)", () => {
    // Invariante de la acumulación: trocear el tramo no cambia el total. Con un
    // floor por pasada, 100 pasadas cortas darían 0 y el tramo entero daría >0.
    const pasadas = 100;
    let s = 0;
    let porPasadas = 0;
    for (let i = 0; i < pasadas; i += 1) {
      porPasadas += needOf(cityNeeds(s, s + PASO, cesta48, B), "pan");
      s += PASO;
    }
    const deUnaVez = needOf(cityNeeds(0, PASO * pasadas, cesta48, B), "pan");
    expect(porPasadas).toBe(deUnaVez);
  });

  test("un bien barato se demanda en CADA pasada corta", () => {
    const needs = cityNeeds(0, PASO, cesta48, B);
    expect(needOf(needs, "pan")).toBeGreaterThan(0);
  });

  test("crecer de población acelera el consumo sin provocar saltos", () => {
    // El acumulador cuenta habitante-segundos, así que un cambio de población
    // solo cambia la PENDIENTE: nunca genera un pico retroactivo (que es lo que
    // pasaría si el acumulador contase segundos y la población multiplicase).
    const s0 = popSecs(1000, 3600);
    const conMil = needOf(cityNeeds(s0, s0 + popSecs(1000, 50), cesta48, B), "pan");
    const conDosMil = needOf(cityNeeds(s0, s0 + popSecs(2000, 50), cesta48, B), "pan");
    expect(conDosMil).toBeGreaterThan(conMil);
    expect(conDosMil).toBeLessThanOrEqual(conMil * 2 + 1);
  });
});

describe("cityNeeds — casos borde", () => {
  test("tramo vacío o invertido ⇒ sin necesidad", () => {
    expect(cityNeeds(1000, 1000, [PAN], B)).toEqual([]);
    expect(cityNeeds(2000, 1000, [PAN], B)).toEqual([]);
  });

  test("cesta vacía ⇒ sin necesidad (y sin dividir por cero)", () => {
    expect(cityNeeds(0, popSecs(1000, 3600), [], B)).toEqual([]);
  });

  test("omite los productos cuya necesidad del tramo redondea a 0", () => {
    const needs = cityNeeds(0, popSecs(1000, 1), [AUTOMOVIL], B);
    expect(needs).toEqual([]);
  });

  test("ignora productos con coste de referencia no positivo (dato corrupto)", () => {
    const needs = cityNeeds(
      0,
      popSecs(1000, 3600),
      [PAN, { productId: "roto", referenceCostCents: 0 }],
      B,
    );
    expect(needOf(needs, "roto")).toBe(0);
    expect(needOf(needs, "pan")).toBeGreaterThan(0);
  });

  test("coste de referencia 1 ¢ y población grande no desbordan el entero seguro", () => {
    const needs = cityNeeds(
      0,
      popSecs(1_000_000, 3600),
      [{ productId: "agua", referenceCostCents: 1 }],
      B,
    );
    expect(Number.isSafeInteger(needOf(needs, "agua"))).toBe(true);
  });

  test("conserva el orden de la cesta (reparto reproducible entre pasadas)", () => {
    const needs = cityNeeds(0, popSecs(100_000, 3600), [PAN, AUTOMOVIL], B);
    expect(needs.map((n) => n.productId)).toEqual(["pan", "automovil"]);
  });

  test("rechaza acumulados negativos o no enteros (bug del caller)", () => {
    expect(() => cityNeeds(-1, 100, [PAN], B)).toThrow(/entero seguro/);
    expect(() => cityNeeds(0, 1.5, [PAN], B)).toThrow(/entero seguro/);
  });
});
