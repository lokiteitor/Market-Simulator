/**
 * CityConsumptionSweeper — el sumidero de bienes de la economía (ADR-029).
 *
 * Por cada ciudad activa: absorbe la vivienda comprada (crece la población),
 * aplica el decaimiento (la encoge si no ha construido) y DESTRUYE la cesta
 * consumida en proporción a su tamaño. La lógica de dominio vive en
 * `cityConsumptionService.consumeForCity`.
 *
 * A diferencia de sus hermanos (fee-ledger, city-income), abre UNA TRANSACCIÓN
 * POR CIUDAD en vez de una para toda la pasada. Dos razones:
 *   - el lock de la fila del agente compite con las órdenes en vuelo de esa misma
 *     ciudad; una tx por ciudad lo mantiene corto y localizado (y la ciudad
 *     lockeada se salta con SKIP LOCKED, recuperando su Δt en la pasada siguiente);
 *   - un fallo aislado (deadlock, dato raro) no tumba las otras 49.
 *
 * POST-COMMIT publica `city_consumed` y `city_population_changed` por ciudad: sin
 * ellos el bot no sabría que su despensa se ha vaciado hasta el próximo snapshot.
 */
import { withTransaction } from "../db";
import { publishToAgent } from "../notifier";
import { logger } from "../observability/logger";
import {
  cityConsumptionUnitsTotal,
  cityHabitantsGainedTotal,
  cityHabitantsLostTotal,
  cityNeedUnmetUnitsTotal,
} from "../observability/metrics";
import { productLabels } from "../observability/product-names";
import {
  cityConsumptionService,
  type CityConsumptionResult,
} from "../services/city-consumption-service";

const log = logger.child({ component: "city-consumption-sweeper" });

export interface CityConsumptionSweepSummary {
  /** Ciudades procesadas con éxito (excluye las lockeadas y las que fallaron). */
  cities: number;
  /** Ciudades saltadas por tener la fila lockeada (SKIP LOCKED). */
  skipped: number;
  /** Ciudades cuya tx falló; se reintentan en la pasada siguiente. */
  failed: number;
  /** Σ unidades destruidas (centésimas). */
  consumedQtyCent: number;
  /** Σ necesidad no cubierta (centésimas). */
  unmetQtyCent: number;
  habitantsGained: number;
  habitantsLost: number;
}

/** Métricas post-commit: solo cuenta lo que realmente se consumió. */
async function recordMetrics(r: CityConsumptionResult): Promise<void> {
  for (const c of r.consumed) {
    cityConsumptionUnitsTotal.inc(await productLabels(c.productId), c.qtyCent);
  }
  for (const u of r.unmet) {
    cityNeedUnmetUnitsTotal.inc(await productLabels(u.productId), u.qtyCent);
  }
  if (r.habitantsGained > 0) cityHabitantsGainedTotal.inc(r.habitantsGained);
  if (r.habitantsLost > 0) cityHabitantsLostTotal.inc(r.habitantsLost);
}

/** Notificaciones post-commit (regla §0). Un fallo de Redis no tumba el job. */
async function notify(r: CityConsumptionResult): Promise<void> {
  const occurredAt = new Date().toISOString();
  const pending: Array<Promise<unknown>> = [];
  if (r.consumed.length > 0 || r.unmet.length > 0) {
    pending.push(
      publishToAgent(r.agentId, {
        type: "city_consumed",
        occurred_at: occurredAt,
        payload: {
          consumed: r.consumed.map((c) => ({
            product_id: c.productId,
            qty_cent: c.qtyCent,
          })),
          unmet: r.unmet.map((u) => ({
            product_id: u.productId,
            qty_cent: u.qtyCent,
          })),
        },
      }),
    );
  }
  if (r.populationAfter !== r.populationBefore) {
    pending.push(
      publishToAgent(r.agentId, {
        type: "city_population_changed",
        occurred_at: occurredAt,
        payload: {
          population: r.populationAfter,
          habitants_gained: r.habitantsGained,
          habitants_lost: r.habitantsLost,
        },
      }),
    );
  }
  await Promise.all(
    pending.map((p) =>
      p.catch((err) =>
        log.error({ err, agentId: r.agentId }, "fallo publicando notificación de consumo urbano"),
      ),
    ),
  );
}

/**
 * Ejecuta una pasada del sweep. Devuelve el resumen para que BullMQ lo registre
 * como `returnValue` y para los tests.
 */
export async function runCityConsumptionSweep(): Promise<CityConsumptionSweepSummary> {
  const cityIds = await withTransaction((tx) => cityConsumptionService.listCityIds(tx));
  const summary: CityConsumptionSweepSummary = {
    cities: 0,
    skipped: 0,
    failed: 0,
    consumedQtyCent: 0,
    unmetQtyCent: 0,
    habitantsGained: 0,
    habitantsLost: 0,
  };
  if (cityIds.length === 0) {
    log.debug("sweep de consumo urbano sin ciudades activas");
    return summary;
  }

  const now = new Date();
  for (const agentId of cityIds) {
    let result: CityConsumptionResult | null;
    try {
      result = await withTransaction((tx) =>
        cityConsumptionService.consumeForCity(tx, agentId, now),
      );
    } catch (err) {
      // Aislado a propósito: la ciudad recupera su Δt en la pasada siguiente
      // porque `last_consumption_at` no se ha movido (la tx hizo rollback).
      summary.failed += 1;
      log.error({ err, agentId }, "fallo consumiendo una ciudad; se reintenta en la próxima pasada");
      continue;
    }
    if (result === null) {
      summary.skipped += 1;
      continue;
    }
    summary.cities += 1;
    summary.consumedQtyCent += result.consumed.reduce((s, c) => s + c.qtyCent, 0);
    summary.unmetQtyCent += result.unmet.reduce((s, u) => s + u.qtyCent, 0);
    summary.habitantsGained += result.habitantsGained;
    summary.habitantsLost += result.habitantsLost;
    await recordMetrics(result);
    await notify(result);
  }

  log.info(summary, "pasada de consumo urbano");
  return summary;
}
