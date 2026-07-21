/**
 * Valores esperados del E2E [M11] — réplica de las reglas numéricas §5/§4.
 *
 * IMPORTANTE (contrato §18): las reglas se IMPORTAN de `src/lib/money` y
 * `src/lib/simtime` para no divergir del servidor. Ojo: esos módulos leen
 * `src/config` (env con defaults de desarrollo); si el servidor bajo prueba
 * corre con FEE_FIXED_CENTS / FEE_RATE_BPS / SIM_TIME_FACTOR distintos a los
 * del entorno donde se ejecuta esta suite, exporta las mismas variables al
 * invocar `bun tests/e2e/run.ts`.
 */
import { feeCents, notionalCents, unitCostFromTotal } from "../../src/lib/money";
import { simSecondsToRealMs, wageCentsForProcess } from "../../src/lib/simtime";

export { notionalCents, feeCents, unitCostFromTotal } from "../../src/lib/money";
export { reserveForQty, releaseForFill } from "../../src/lib/money";
export { simSecondsToRealMs, wageCentsForProcess } from "../../src/lib/simtime";
export { splitFeeForCity } from "../../src/services/city-income-service";
export { config } from "../../src/config";

export interface ExpectedTradeNumbers {
  /** Costo del trade: notionalCents(execQty, precio pasivo). */
  costCents: number;
  /** Fee de CADA lado (sin capar; los agentes del E2E tienen capital de sobra). */
  feePerSideCents: number;
  /** unit_cost_cents del lote purchase del comprador: (cost + fee_buyer) / qty. */
  buyerLotUnitCostCents: number;
  /** Δ capital total del comprador: −cost − fee. */
  buyerCapitalDeltaCents: number;
  /** Δ capital total del vendedor: +cost − fee. */
  sellerCapitalDeltaCents: number;
}

/**
 * Números esperados de un trade ejecutado a `passivePriceCents` (precio de la
 * orden PASIVA, §10.1) por `execQtyCent` centésimas de unidad (§5).
 */
export function expectedTradeNumbers(execQtyCent: number, passivePriceCents: number): ExpectedTradeNumbers {
  const costCents = notionalCents(execQtyCent, passivePriceCents);
  const feePerSideCents = feeCents(costCents);
  return {
    costCents,
    feePerSideCents,
    buyerLotUnitCostCents: unitCostFromTotal(costCents + feePerSideCents, execQtyCent),
    buyerCapitalDeltaCents: -(costCents + feePerSideCents),
    sellerCapitalDeltaCents: costCents - feePerSideCents,
  };
}

export interface ExpectedProcessNumbers {
  /** Salario upfront: wage_rate × duración_sim × ejecuciones (§4). */
  wageCents: number;
  /** Cantidad producida: output_qty_cent × ejecuciones (§10.8). */
  producedQtyCent: number;
  /** unit_cost del lote production: (Σ insumos + salario) / qty (§10.8). */
  producedLotUnitCostCents: number;
  /** Duración real total en ms: simSecondsToRealMs(duración_sim × ejecuciones). */
  totalRealDurationMs: number;
}

/** Números esperados de un proceso SIN insumos (receta primaria, p. ej. germinado_rapido). */
export function expectedPrimaryProcessNumbers(p: {
  durationSimSeconds: number;
  wageRateCentsPerSec: number;
  outputQtyCent: number;
  executions: number;
}): ExpectedProcessNumbers {
  const wageCents = wageCentsForProcess(p.wageRateCentsPerSec, p.durationSimSeconds, p.executions);
  const producedQtyCent = p.outputQtyCent * p.executions;
  return {
    wageCents,
    producedQtyCent,
    producedLotUnitCostCents: unitCostFromTotal(wageCents, producedQtyCent),
    totalRealDurationMs: simSecondsToRealMs(p.durationSimSeconds * p.executions),
  };
}
