/**
 * Servicio de quiebra [M2 agents] — contratos §8 y §10.13; diseño §10.
 *
 * `checkAndApply(tx, agentId)` se llama DESPUÉS de transiciones terminales
 * (cancel/expire de orden, complete/cancel de proceso), DENTRO de la misma
 * transacción del caller. `evaluateAndApply` es la misma evaluación devolviendo
 * el detalle (estado + motivos) en vez de un booleano: la usa el endpoint
 * `POST /agents/me/bankruptcy-check`, la vía PULL por la que un bot sin capital
 * pregunta si debe apagarse (ADR-026). Ambas comparten cuerpo, condición y
 * efectos; `checkAndApply` es un envoltorio.
 *
 * Condición de quiebra (EXACTA, contrato §8):
 *   capital_available + capital_reserved === 0
 *   Y getTotalInventory === 0            (Σ available+reserved de lotes)
 *   Y sin órdenes en status active/partial
 *   Y sin procesos running.
 *
 * Al aplicarse:
 *   1. Cancela órdenes activas/parciales residuales liberando reservas
 *      (§5 para capital de compras; releaseReservedFifo para inventario de
 *      ventas) + appendEvent(order_cancelled) por cada una. Con la condición
 *      exacta este barrido es vacío en la práctica (reservas 0 implican que no
 *      hay órdenes con valor); se ejecuta igualmente como defensa ante
 *      rezagados concurrentes de valor nocional 0.
 *   2. Marca bankrupt + bankrupt_at.
 *   3. Revoca todos los refresh tokens del agente (AuthService [M1], §10.13).
 *   4. appendEvent(agent_bankrupt).
 *
 * NO publica notificaciones: el CALLER publica post-commit
 * (bankruptcy_notice personal + agent_bankrupt broadcast) si devolvió true.
 * El inventario congelado no se toca (§10.13): las filas de lote quedan.
 */
import type { Tx } from "../db";
import { appendEvent } from "../lib/event-log";
import { notionalCents } from "../lib/money";
import { agentRepository } from "../repositories/agent-repository";
import type {
  BankruptcyEvaluation,
  BankruptcyReason,
  BankruptcyService,
} from "../types/contracts";
import { revokeAllForAgent } from "./auth-service";
import { inventoryService } from "./inventory-service";

/** Agente inexistente o exento: nada que aplicar, sin motivos que informar. */
function notBankrupt(
  username: string,
  reasons: BankruptcyReason[],
): BankruptcyEvaluation {
  return { applied: false, bankrupt: false, bankruptAt: null, username, reasons };
}

/**
 * Cuerpo común. `collectAllReasons` decide si se sigue consultando tras el
 * primer motivo: `checkAndApply` (hot path de cancelación/expiración, donde lo
 * único que importa es el booleano) corta en el primero y conserva su coste
 * histórico; el endpoint los quiere todos para poder explicárselos al bot.
 */
async function evaluate(
  tx: Tx,
  agentId: string,
  collectAllReasons: boolean,
): Promise<BankruptcyEvaluation> {
  // Lock de la fila del agente: serializa evaluaciones de quiebra
  // concurrentes y congela el capital mientras se decide.
  const agentRow = await agentRepository.findByIdForUpdate(tx, agentId);
  if (agentRow === undefined) return notBankrupt("", []);
  if (agentRow.status === "bankrupt") {
    // Idempotente: ya estaba quebrado, no se reaplica ni se re-notifica.
    return {
      applied: false,
      bankrupt: true,
      bankruptAt: agentRow.bankruptAt,
      username: agentRow.username,
      reasons: [],
    };
  }

  // Las ciudades NO quiebran: son infraestructura de demanda, no operadores.
  // Cumplen la condición §8 de forma natural (gastan su capital y consumen
  // los bienes que compran, así que se quedan en 0/0 entre repartos), y
  // marcarlas bankrupt las dejaría fuera para siempre: authService.login
  // rechaza a los quebrados y su bot no podría reconectar. Se recuperan solas
  // con el siguiente reparto del city-income-sweeper.
  //
  // El admin tampoco quiebra: es la cuenta personal del operador humano y
  // además la única vía de acceso al panel (login rechaza a los quebrados).
  if (agentRow.role === "city" || agentRow.role === "admin") {
    return notBankrupt(agentRow.username, ["role_exempt"]);
  }

  // --- Condición exacta (§8) -----------------------------------------------
  const reasons: BankruptcyReason[] = [];
  const done = (): boolean => reasons.length > 0 && !collectAllReasons;

  if (agentRow.capitalAvailable + agentRow.capitalReserved !== 0) {
    reasons.push("has_capital");
  }
  if (!done() && (await inventoryService.getTotalInventory(tx, agentId)) !== 0) {
    reasons.push("has_inventory");
  }
  if (!done() && (await agentRepository.countActiveOrders(tx, agentId)) !== 0) {
    reasons.push("has_active_orders");
  }
  if (!done() && (await agentRepository.countRunningProcesses(tx, agentId)) !== 0) {
    reasons.push("has_running_processes");
  }
  if (reasons.length > 0) return notBankrupt(agentRow.username, reasons);

  // --- Aplicar quiebra -------------------------------------------------------

  // 1. Cancelación residual de órdenes active/partial (defensa; ver cabecera).
  const residualOrders = await agentRepository.listActiveOrdersForUpdate(tx, agentId);
  for (const order of residualOrders) {
    if (order.side === "buy") {
      // Cierre §5: liberar notional(qty_pending, limit) de reserved → available.
      const reserve = notionalCents(order.qtyPending, order.limitPriceCents);
      if (reserve > 0) {
        await agentRepository.releaseReserved(tx, agentId, reserve);
      }
    } else if (order.qtyPending > 0) {
      await inventoryService.releaseReservedFifo(
        tx,
        agentId,
        order.productId,
        order.qtyPending,
      );
    }
    await agentRepository.markOrderCancelled(tx, order.orderId);
    await appendEvent(tx, {
      type: "order_cancelled",
      agentId,
      payload: {
        order_id: order.orderId,
        agent_id: agentId,
        product_id: order.productId,
        qty_pending_cent: order.qtyPending,
      },
    });
  }

  // 2. Marcar bankrupt + bankrupt_at.
  const bankruptAt = new Date();
  await agentRepository.markBankrupt(tx, agentId, bankruptAt);

  // 3. Revocar todos los refresh tokens (§10.13; M1 exporta, M2 consume).
  await revokeAllForAgent(tx, agentId);

  // 4. Evento de dominio (misma tx; notificaciones las publica el caller
  //    post-commit).
  await appendEvent(tx, {
    type: "agent_bankrupt",
    agentId,
    payload: { agent_id: agentId, username: agentRow.username },
  });

  return {
    applied: true,
    bankrupt: true,
    bankruptAt,
    username: agentRow.username,
    reasons: [],
  };
}

export const bankruptcyService: BankruptcyService = {
  async checkAndApply(tx: Tx, agentId: string): Promise<boolean> {
    return (await evaluate(tx, agentId, false)).applied;
  },

  async evaluateAndApply(tx: Tx, agentId: string): Promise<BankruptcyEvaluation> {
    return evaluate(tx, agentId, true);
  },
};
