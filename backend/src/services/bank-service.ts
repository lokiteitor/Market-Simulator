/**
 * Service del banco central (patrón oro) — ventanilla de convertibilidad.
 *
 * Semántica ACUÑADORA (patrón oro clásico):
 *   - sell_gold: el agente entrega oro (FIFO de sus lotes) y recibe dinero
 *     RECIÉN ACUÑADO a window_bid (money_issued += total). El capital del
 *     banco NO se toca. Como bid ≤ parity, la cobertura nunca empeora.
 *   - buy_gold: el agente paga a window_ask y ese dinero se DESTRUYE
 *     (money_burned += total); recibe oro de los lotes del banco. Como
 *     ask ≥ parity, la cobertura tampoco empeora.
 *
 * Concurrencia (orden global de locks, ver bank-repository):
 *   gold_standard FOR UPDATE (mínimo) → fila del agente caller → lotes FIFO.
 *   La fila del agente banco NUNCA se escribe aquí (la acuñación no la toca);
 *   solo el matching la escribe (crédito de fees, último lock de su tx).
 *
 * Notificación personal `gold_converted` SOLO post-commit (patrón safePublish).
 */
import { withTransaction, type Tx } from "../db";
import type { GoldConversionRow, GoldStandardRow } from "../db/schema";
import { DomainError, domainError } from "../lib/errors";
import { appendEvent, type GoldConvertedPayload } from "../lib/event-log";
import { issuanceCapacityCents } from "../lib/gold";
import { notionalCents, unitCostFromTotal } from "../lib/money";
import { publishToAgent } from "../notifier";
import { logger } from "../observability/logger";
import { bankRepository } from "../repositories/bank-repository";
import { depositRepository } from "../repositories/deposit-repository";
import type { BankInfoDto, ConvertRequestDto, GoldConversionDto } from "../schemas/bank";
import { inventoryService } from "./inventory-service";
import { creditAvailable } from "./matching/capital";

const log = logger.child({ module: "bank-service" });

function toConversionDto(row: GoldConversionRow): GoldConversionDto {
  return {
    conversion_id: row.conversionId,
    agent_id: row.agentId,
    direction: row.direction,
    product_id: row.productId,
    qty_cent: row.qtyCent,
    price_cents_per_unit: row.priceCentsPerUnit,
    total_cents: row.totalCents,
    executed_at: row.executedAt.toISOString(),
  };
}

/** gold_standard FOR UPDATE o 409 no_gold_standard (corrida sin patrón oro). */
async function requireGoldStandardLocked(tx: Tx): Promise<GoldStandardRow> {
  const gs = await bankRepository.lockGoldStandard(tx);
  if (gs === undefined) {
    throw domainError(
      "no_gold_standard",
      "Esta corrida no tiene patrón oro sembrado (tabla gold_standard vacía).",
    );
  }
  return gs;
}

async function getBankInfo(): Promise<BankInfoDto> {
  return withTransaction(async (tx) => {
    const gs = await bankRepository.getGoldStandard(tx);
    if (gs === undefined) {
      throw domainError(
        "no_gold_standard",
        "Esta corrida no tiene patrón oro sembrado (tabla gold_standard vacía).",
      );
    }
    const bank = await bankRepository.findAgent(tx, gs.bankAgentId);
    const goldAvailable = await bankRepository.getGoldAvailable(tx, gs.bankAgentId, gs.productId);
    const depositRemaining = await depositRepository.getRemaining(tx, gs.productId);
    return {
      bank_agent_id: gs.bankAgentId,
      product_id: gs.productId,
      parity_cents_per_unit: gs.parityCentsPerUnit,
      window_bid_cents: gs.windowBidCents,
      window_ask_cents: gs.windowAskCents,
      coverage_ratio_bps: gs.coverageRatioBps,
      initial_money_cents: gs.initialMoneyCents,
      money_issued_cents: gs.moneyIssuedCents,
      money_burned_cents: gs.moneyBurnedCents,
      issuance_capacity_cents: issuanceCapacityCents(
        goldAvailable,
        gs.parityCentsPerUnit,
        gs.coverageRatioBps,
      ),
      bank_gold_available_cent: goldAvailable,
      bank_capital_available_cents: bank?.capitalAvailable ?? 0,
      deposit_remaining_cent: depositRemaining ?? null,
    };
  });
}

async function convert(agentId: string, input: ConvertRequestDto): Promise<GoldConversionDto> {
  const result = await withTransaction(async (tx) => {
    // Orden de locks: gold_standard (mínimo) ANTES que la fila del agente.
    const gs = await requireGoldStandardLocked(tx);

    const caller = await bankRepository.lockAgent(tx, agentId);
    if (caller === undefined) {
      throw domainError("unknown_agent", `El agente ${agentId} no existe.`);
    }
    if (caller.role === "bank" || caller.role === "admin") {
      throw domainError("forbidden", "El banco y los administradores no operan la ventanilla.");
    }
    if (caller.status === "bankrupt") {
      throw domainError("agent_bankrupt", "El agente está en quiebra y no puede operar.");
    }

    const qtyCent = input.qty_cent;
    const price = input.direction === "sell_gold" ? gs.windowBidCents : gs.windowAskCents;
    const totalCents = notionalCents(qtyCent, price);
    if (totalCents === 0) {
      // Nocional sub-centavo: en sell_gold el agente regalaría oro; en
      // buy_gold recibiría oro gratis. Mismo criterio que placeOrder.
      throw domainError(
        "conversion_below_minimum",
        `El nocional de la conversión (qty_cent=${qtyCent} × ${price} / 100) redondea a 0 centavos.`,
        { field: "qty_cent" },
      );
    }

    let consumptions: Array<{ lotId: string; qtyCent: number; unitCostCents: number }>;
    if (input.direction === "sell_gold") {
      // El agente entrega oro (sus lotes, FIFO) → insufficient_inventory.
      consumptions = await inventoryService.consumeAvailableFifo(
        tx,
        agentId,
        gs.productId,
        qtyCent,
      );
    } else {
      // El banco entrega oro; su falta se reporta como bank_insufficient_gold.
      try {
        consumptions = await inventoryService.consumeAvailableFifo(
          tx,
          gs.bankAgentId,
          gs.productId,
          qtyCent,
        );
      } catch (err) {
        if (err instanceof DomainError && err.code === "insufficient_inventory") {
          throw domainError(
            "bank_insufficient_gold",
            `El banco no tiene ${qtyCent} centésimas de oro disponibles en reserva.`,
            { field: "qty_cent" },
          );
        }
        throw err;
      }
      // El pago del agente se DESTRUYE (débito condicional sin contrapartida).
      const debited = await bankRepository.debitAgentCapital(tx, agentId, totalCents);
      if (!debited) {
        throw domainError(
          "insufficient_capital",
          `Se requieren ${totalCents} centavos disponibles para comprar ${qtyCent} centésimas de oro.`,
          { field: "qty_cent" },
        );
      }
    }

    const conversion = await bankRepository.insertConversion(tx, {
      agentId,
      direction: input.direction,
      productId: gs.productId,
      qtyCent,
      priceCentsPerUnit: price,
      totalCents,
    });
    await bankRepository.insertConversionLotConsumptions(
      tx,
      consumptions.map((c) => ({
        conversionId: conversion.conversionId,
        lotId: c.lotId,
        qtyConsumed: c.qtyCent,
        unitCostCents: c.unitCostCents,
      })),
    );

    // Lote de destino (origin 'conversion'). Coste: lo pagado/cobrado en la
    // ventanilla, prorrateado por unidad.
    const lotOwner = input.direction === "sell_gold" ? gs.bankAgentId : agentId;
    await inventoryService.createLot(tx, {
      agentId: lotOwner,
      productId: gs.productId,
      origin: "conversion",
      qtyCent,
      unitCostCents: unitCostFromTotal(totalCents, qtyCent),
      sourceConversionId: conversion.conversionId,
    });

    // Acuñación / destrucción (gold_standard sigue bloqueada por esta tx).
    if (input.direction === "sell_gold") {
      await bankRepository.addMoneyIssued(tx, totalCents);
      // El agente cobra dinero nuevo (su fila ya está bloqueada por lockAgent).
      await creditAvailable(tx, agentId, totalCents);
    } else {
      await bankRepository.addMoneyBurned(tx, totalCents);
    }

    const payload: GoldConvertedPayload = {
      conversion_id: conversion.conversionId,
      agent_id: agentId,
      direction: input.direction,
      product_id: gs.productId,
      qty_cent: qtyCent,
      price_cents_per_unit: price,
      total_cents: totalCents,
    };
    await appendEvent(tx, { type: "gold_converted", agentId, payload });

    return toConversionDto(conversion);
  });

  // Notificación personal post-commit, best-effort.
  try {
    await publishToAgent(agentId, {
      type: "gold_converted",
      occurred_at: result.executed_at,
      payload: result,
    });
  } catch (err) {
    log.warn({ err, conversionId: result.conversion_id }, "fallo notificando gold_converted");
  }
  return result;
}

export const bankService = {
  getBankInfo,
  convert,
};
