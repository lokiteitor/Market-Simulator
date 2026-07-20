/**
 * CityIncomeService — reparto del ingreso recurrente de las ciudades (flujo
 * circular). Gemelo funcional de `bankService.materializeFees`, pero en vez de
 * plegar a UN agente (el banco), REPARTE lo pendiente del `income_ledger` entre
 * TODAS las ciudades activas, ponderado por `population_weight`.
 *
 * Invocado por el city-income-sweeper del Worker (concurrency 1 ⇒ sin solape).
 * Devuelve el detalle por ciudad para que el sweeper publique la notificación
 * WS `city_income` POST-COMMIT (así el bot ve su capital y lo gasta).
 *
 * Conservación: `materializePending` marca el lote como repartido y en la MISMA
 * tx se acredita a las ciudades; el residuo del reparto entero (floor) va a la
 * ciudad de mayor peso, de modo que Σ repartido == Σ reclamado (exacto).
 */
import { config } from "../config";
import type { Tx } from "../db";
import { appendEvent } from "../lib/event-log";
import { agentRepository } from "../repositories/agent-repository";
import { incomeLedgerRepository } from "../repositories/income-ledger-repository";

export interface CityIncomeDistribution {
  agentId: string;
  amountCents: number;
}

export interface CityIncomeResult {
  totalCents: number;
  distributions: CityIncomeDistribution[];
}

export interface CityWeight {
  agentId: string;
  populationWeight: number;
}

/**
 * Reparto ponderado PURO (testeable sin DB, como `splitFifo`): asigna a cada
 * ciudad `floor(claimed * w_i / Σw)` y da el residuo del floor a la ciudad de
 * mayor peso (empates: la primera del listado). Garantiza el invariante
 * Σ repartido == claimedCents EXACTO, imprescindible para la conservación.
 *
 * Devuelve solo las ciudades con importe > 0.
 */
export function splitIncomeByWeight(
  claimedCents: number,
  cities: readonly CityWeight[],
): CityIncomeDistribution[] {
  if (claimedCents <= 0 || cities.length === 0) return [];
  const totalWeight = cities.reduce((s, c) => s + c.populationWeight, 0);
  if (totalWeight <= 0) return [];

  const byAgent = new Map<string, number>();
  let distributed = 0;
  for (const c of cities) {
    const share = Math.floor((claimedCents * c.populationWeight) / totalWeight);
    if (share > 0) {
      byAgent.set(c.agentId, (byAgent.get(c.agentId) ?? 0) + share);
      distributed += share;
    }
  }

  const remainder = claimedCents - distributed;
  if (remainder > 0) {
    const largest = cities.reduce((a, b) =>
      b.populationWeight > a.populationWeight ? b : a,
    );
    byAgent.set(largest.agentId, (byAgent.get(largest.agentId) ?? 0) + remainder);
  }

  return [...byAgent].map(([agentId, amountCents]) => ({ agentId, amountCents }));
}

/**
 * Split PURO del fee de un trade entre banco y ciudades (tasa de consumo).
 * La ciudad se lleva `floor(fee * bps / 10000)` y el banco el resto, de modo
 * que cityShare + bankShare == feeCents EXACTO (no se crea ni destruye dinero).
 */
export function splitFeeForCity(
  feeCents: number,
  cityShareBps: number,
): { bankShareCents: number; cityShareCents: number } {
  if (feeCents <= 0) return { bankShareCents: 0, cityShareCents: 0 };
  const cityShareCents = Math.floor((feeCents * cityShareBps) / 10000);
  return { bankShareCents: feeCents - cityShareCents, cityShareCents };
}

/**
 * Reclama hasta `limit` filas pendientes del income_ledger y las reparte entre
 * las ciudades activas. Devuelve el total repartido y el detalle por ciudad.
 */
async function materializeIncome(
  tx: Tx,
  limit: number = config.sweeps.batchSize,
): Promise<CityIncomeResult> {
  // Leer las ciudades ANTES de materializar: si no hay ninguna activa, NO se
  // reclama nada (dejar el dinero pendiente evita que desaparezca de la
  // conservación al marcarlo materialized sin destino).
  const cities = await agentRepository.listActiveCitiesWithWeight(tx);
  if (cities.length === 0) {
    return { totalCents: 0, distributions: [] };
  }

  const claimedCents = await incomeLedgerRepository.materializePending(tx, limit);
  if (claimedCents <= 0) {
    return { totalCents: 0, distributions: [] };
  }

  const distributions = splitIncomeByWeight(claimedCents, cities);
  for (const d of distributions) {
    await agentRepository.creditAvailable(tx, d.agentId, d.amountCents);
  }

  await appendEvent(tx, {
    type: "city_income_distributed",
    payload: { total_cents: claimedCents, city_count: distributions.length },
  });

  return { totalCents: claimedCents, distributions };
}

export const cityIncomeService = {
  materializeIncome,
};
