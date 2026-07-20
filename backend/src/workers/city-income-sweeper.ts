/**
 * CityIncomeSweeper (flujo circular — gemelo del fee-ledger-sweeper).
 *
 * Job recurrente: pliega el ingreso no materializado de `income_ledger`
 * (salarios reciclados + tasa de consumo) y lo REPARTE entre las ciudades
 * activas ponderado por population_weight. La lógica de dominio vive en
 * `cityIncomeService.materializeIncome` (una tx; el reparto es exacto). El
 * no-solape lo garantiza el worker (concurrency 1 por cola).
 *
 * POST-COMMIT publica una notificación WS `city_income` por ciudad para que el
 * bot vea su capital y lo gaste (sin esto el ingreso sube en la DB pero el bot
 * no lo percibe hasta el próximo snapshot).
 */
import { config } from "../config";
import { withTransaction } from "../db";
import { publishToAgent } from "../notifier";
import { logger } from "../observability/logger";
import {
  cityIncomeDistributedCentsTotal,
  cityIncomePayoutsTotal,
} from "../observability/metrics";
import { cityIncomeService } from "../services/city-income-service";

const log = logger.child({ component: "city-income-sweeper" });

/**
 * Ejecuta una pasada del sweep. Devuelve los centavos de ingreso repartidos a
 * las ciudades en esta pasada.
 */
export async function runCityIncomeSweep(
  batchSize: number = config.sweeps.batchSize,
): Promise<number> {
  const result = await withTransaction((tx) =>
    cityIncomeService.materializeIncome(tx, batchSize),
  );

  if (result.totalCents > 0) {
    // Métricas post-commit: solo se cuenta lo que realmente se acreditó.
    cityIncomeDistributedCentsTotal.inc(result.totalCents);
    cityIncomePayoutsTotal.inc(result.distributions.length);

    // Post-commit (regla §0): notificar a cada ciudad su ingreso.
    const occurredAt = new Date().toISOString();
    await Promise.all(
      result.distributions.map((d) =>
        publishToAgent(d.agentId, {
          type: "city_income",
          occurred_at: occurredAt,
          payload: { amount_cents: d.amountCents },
        }).catch((err) =>
          log.error({ err, agentId: d.agentId }, "fallo publicando city_income"),
        ),
      ),
    );
    log.info(
      { totalCents: result.totalCents, cities: result.distributions.length },
      "ingreso repartido a ciudades",
    );
  } else {
    log.debug({ batchSize }, "sweep de ingreso de ciudades sin pendientes");
  }
  return result.totalCents;
}
