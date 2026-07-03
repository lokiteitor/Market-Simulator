/**
 * Servicio de quiebra [M2 agents] — contratos §8 y §10.13; diseño §10.
 *
 * `checkAndApply(tx, agentId)` se llama DESPUÉS de transiciones terminales
 * (cancel/expire de orden, complete/cancel de proceso), DENTRO de la misma
 * transacción del caller.
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
import type { BankruptcyService } from "../types/contracts";
import { revokeAllForAgent } from "./auth-service";
import { inventoryService } from "./inventory-service";

export const bankruptcyService: BankruptcyService = {
  async checkAndApply(tx: Tx, agentId: string): Promise<boolean> {
    // Lock de la fila del agente: serializa evaluaciones de quiebra
    // concurrentes y congela el capital mientras se decide.
    const agentRow = await agentRepository.findByIdForUpdate(tx, agentId);
    if (agentRow === undefined) return false;
    if (agentRow.status === "bankrupt") return false; // idempotente

    // --- Condición exacta (§8) ---------------------------------------------
    if (agentRow.capitalAvailable + agentRow.capitalReserved !== 0) return false;

    const totalInventory = await inventoryService.getTotalInventory(tx, agentId);
    if (totalInventory !== 0) return false;

    const activeOrders = await agentRepository.countActiveOrders(tx, agentId);
    if (activeOrders !== 0) return false;

    const runningProcesses = await agentRepository.countRunningProcesses(tx, agentId);
    if (runningProcesses !== 0) return false;

    // --- Aplicar quiebra -----------------------------------------------------

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
    await agentRepository.markBankrupt(tx, agentId);

    // 3. Revocar todos los refresh tokens (§10.13; M1 exporta, M2 consume).
    await revokeAllForAgent(tx, agentId);

    // 4. Evento de dominio (misma tx; notificaciones las publica el caller
    //    post-commit).
    await appendEvent(tx, {
      type: "agent_bankrupt",
      agentId,
      payload: { agent_id: agentId, username: agentRow.username },
    });

    return true;
  },
};
