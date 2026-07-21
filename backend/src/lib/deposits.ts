/**
 * Aritmética de los yacimientos finitos (ADR-023).
 *
 * Un `resource_deposit` es el stock global de un recurso no renovable. La
 * materialización de un proceso que produce ese recurso no rinde el output
 * nominal de la receta: rinde **menos a medida que el yacimiento se vacía**
 * (rendimiento decreciente), y el yacimiento se decrementa por lo realmente
 * extraído.
 *
 * Por qué decreciente y no un corte seco: hierro y carbón alimentan el acero
 * (56 productos aguas abajo cada uno) y el petróleo otros 58. Un corte binario
 * mataría esas cadenas de golpe y sin aviso. Con rendimiento decreciente el
 * mismo salario e insumos producen menos unidades, así que el coste unitario
 * del lote sube solo (`unitCostFromTotal` reparte el coste entre menos unidades)
 * y el mercado reasigna producción antes del colapso.
 *
 * Cantidades: BIGINT en centésimas de unidad (qtyCent). Toda la aritmética pasa
 * por BigInt con redondeo floor, igual que `lib/money.ts` y `lib/gold.ts`.
 */

/** Base de los rendimientos: 10000 bps = 100% (la receta rinde su output nominal). */
const FULL_YIELD_BPS = 10000n;

export interface DepositYield {
  /** Cantidad realmente extraída (≤ planificado y ≤ remanente). */
  producedQtyCent: number;
  /** Remanente del yacimiento tras la extracción. */
  remainingAfterCent: number;
  /** Rendimiento aplicado, en bps sobre el output nominal (10000 = 100%). */
  yieldBps: number;
}

function assertQtyCent(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`depositYield: ${name} debe ser un entero >= 0; recibido: ${value}`);
  }
}

/**
 * Rendimiento del yacimiento en bps: `max(floor, remaining / inicial)`.
 *
 * Con el yacimiento intacto vale 10000 (la receta rinde su output nominal) y
 * baja linealmente hasta el suelo. Un yacimiento vacío rinde 0 pase lo que pase
 * con el suelo: sin remanente no hay nada que extraer. `qtyInitialCent === 0`
 * (posible con GOLD_BANK_INITIAL_RESERVE_BPS=10000, que deja el yacimiento
 * minable en 0) también rinde 0, y de paso evita la división por cero.
 */
export function depositYieldBps(
  qtyInitialCent: number,
  qtyRemainingCent: number,
  yieldFloorBps: number,
): number {
  assertQtyCent("qtyInitialCent", qtyInitialCent);
  assertQtyCent("qtyRemainingCent", qtyRemainingCent);
  assertQtyCent("yieldFloorBps", yieldFloorBps);
  if (qtyInitialCent === 0 || qtyRemainingCent === 0) return 0;
  const ratio = (BigInt(qtyRemainingCent) * FULL_YIELD_BPS) / BigInt(qtyInitialCent);
  const floor = BigInt(yieldFloorBps);
  const applied = ratio < floor ? floor : ratio;
  // El remanente puede superar al inicial solo por un bug de datos; acotar a
  // 100% deja el rendimiento dentro del contrato pase lo que pase.
  return Number(applied > FULL_YIELD_BPS ? FULL_YIELD_BPS : applied);
}

/**
 * Extracción de un yacimiento: escala la cantidad planificada por el
 * rendimiento actual y la acota al remanente físico.
 *
 *   producido = min(floor(planificado × yieldBps / 10000), remanente)
 *
 * El `min` contra el remanente es lo que hace que el yacimiento llegue a 0 de
 * verdad: en la cola, cuando el rendimiento ya está en el suelo, la última
 * extracción se lleva lo que quede.
 */
export function depositYield(
  qtyInitialCent: number,
  qtyRemainingCent: number,
  qtyPlannedCent: number,
  yieldFloorBps: number,
): DepositYield {
  assertQtyCent("qtyPlannedCent", qtyPlannedCent);
  const yieldBps = depositYieldBps(qtyInitialCent, qtyRemainingCent, yieldFloorBps);
  const scaled = (BigInt(qtyPlannedCent) * BigInt(yieldBps)) / FULL_YIELD_BPS;
  const remaining = BigInt(qtyRemainingCent);
  const produced = scaled < remaining ? scaled : remaining;
  return {
    producedQtyCent: Number(produced),
    remainingAfterCent: Number(remaining - produced),
    yieldBps,
  };
}
