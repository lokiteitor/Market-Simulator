/**
 * Plan determinista de yacimientos finitos (ADR-023).
 *
 * Los recursos no renovables se marcan con `finite: true` en el catálogo
 * (`infra/seed-config.json`); el TAMAÑO no se declara producto a producto, sino
 * como un rango global en EJECUCIONES de la receta
 * (DEPOSIT_MIN/MAX_EXECUTIONS). Así el yacimiento se autoajusta si cambia el
 * rendimiento de la receta y la magnitud es legible ("la mina da para ~40.000
 * coladas") en vez de un número de centésimas con ocho ceros.
 *
 * El oro NO pasa por aquí: su yacimiento lo sortea `gold-plan.ts` en centésimas
 * porque la paridad monetaria se deriva de él (`parity = f(M0, D, coverage)`).
 * El rango por defecto (28.000–52.000 ejecuciones) es justo el presupuesto
 * implícito del yacimiento de oro, para que todos los recursos duren lo mismo
 * en días-línea.
 */
import { randIntInclusive, rngFor } from "../lib/rng";
import type { SeedConfig } from "./seed-config";

/** Prefijo de la clave RNG por yacimiento (determinista con MASTER_SEED). */
export const DEPOSIT_RNG_PREFIX = "deposit:";

export interface SeedDepositPlanEntry {
  /** `key` del producto en el catálogo (p. ej. `carbon`). */
  productKey: string;
  /** Ejecuciones sorteadas: el tamaño en unidades de receta. */
  executions: number;
  /** Tamaño del yacimiento: ejecuciones × output_qty_cent de su receta. */
  qtyInitialCent: number;
}

/**
 * Plan determinista de yacimientos: por cada producto `finite`, sortea las
 * ejecuciones con rngFor(masterSeed, "deposit:{key}") —independiente del orden
 * de recorrido, como el resto del seed— y las convierte a qty_cent con el
 * output de su receta única (`parseSeedConfig` ya garantizó que es una sola).
 */
export function buildDepositPlan(
  cfg: SeedConfig,
  opts: { masterSeed: number; minExecutions: number; maxExecutions: number },
): SeedDepositPlanEntry[] {
  const outputQtyByProduct = new Map<string, number>();
  for (const r of cfg.recipes) {
    outputQtyByProduct.set(r.output, r.output_qty_cent);
  }

  const plan: SeedDepositPlanEntry[] = [];
  for (const p of cfg.products) {
    if (p.finite !== true) continue;
    const outputQtyCent = outputQtyByProduct.get(p.key);
    if (outputQtyCent === undefined) {
      // Inalcanzable: parseSeedConfig exige exactamente una receta por producto
      // finito. Solo puede ocurrir por un bug del propio parseo.
      throw new Error(`buildDepositPlan: producto finito "${p.key}" sin receta que lo produzca`);
    }
    const rng = rngFor(opts.masterSeed, `${DEPOSIT_RNG_PREFIX}${p.key}`);
    const executions = randIntInclusive(rng, opts.minExecutions, opts.maxExecutions);
    plan.push({
      productKey: p.key,
      executions,
      qtyInitialCent: executions * outputQtyCent,
    });
  }
  return plan;
}
