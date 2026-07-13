/**
 * Service de visibilidad de mercado (lecturas puras) — [M6 read-side].
 *
 * Nivel 1 (diseño §13): UNA orden por lado (la primera en cola precio-tiempo)
 * con la identidad del agente; el resto del libro es privado. Los trades
 * ejecutados son públicos con identidades de ambas contrapartes.
 */
import { withTransaction } from "../db";
import type { MarketOrderRow, TradeRow } from "../db/schema";
import { domainError } from "../lib/errors";
import { simSecondsToRealMs } from "../lib/simtime";
import { catalogRepository } from "../repositories/catalog-repository";
import { marketRepository } from "../repositories/market-repository";

/** Ventana por defecto de /market/{id}/trades: último día SIMULADO (openapi). */
const DEFAULT_TRADES_WINDOW_SIM_SECONDS = 86_400;

export interface TopOfBookSide {
  orderId: string;
  agentId: string;
  priceCents: number;
  qtyPendingCent: number;
}

export interface TopOfBook {
  productId: string;
  observedAt: Date;
  bestBid: TopOfBookSide | null;
  bestAsk: TopOfBookSide | null;
}

function toSide(row: MarketOrderRow | undefined): TopOfBookSide | null {
  if (row === undefined) return null;
  return {
    orderId: row.orderId,
    agentId: row.agentId,
    priceCents: row.limitPriceCents,
    qtyPendingCent: row.qtyPending,
  };
}

async function assertProductExists(
  tx: Parameters<typeof catalogRepository.getProduct>[0],
  productId: string,
): Promise<void> {
  const product = await catalogRepository.getProduct(tx, productId);
  if (product === undefined) {
    throw domainError("unknown_product", `No existe el producto ${productId}.`, {
      field: "product_id",
    });
  }
}

export const marketService = {
  /**
   * Top of book del producto: mejor bid y mejor ask vigentes
   * (status active/partial Y expires_at > now), ambos leídos en la misma
   * transacción para una foto consistente.
   *
   * @throws DomainError unknown_product (404)
   */
  async getTopOfBook(productId: string): Promise<TopOfBook> {
    return withTransaction(async (tx) => {
      await assertProductExists(tx, productId);
      const observedAt = new Date();
      const bestBid = await marketRepository.bestOrder(tx, productId, "buy", observedAt);
      const bestAsk = await marketRepository.bestOrder(tx, productId, "sell", observedAt);
      return {
        productId,
        observedAt,
        bestBid: toSide(bestBid),
        bestAsk: toSide(bestAsk),
      };
    });
  },

  /**
   * Trades recientes del producto. La ventana por defecto del último día
   * simulado solo aplica sin NINGÚN filtro temporal: con `until` o `before`
   * (backfill hacia atrás) un piso implícito cortaría la paginación.
   *
   * `before` (cursor keyset) se resuelve a su (executed_at, trade_id); debe
   * existir y pertenecer al mismo producto.
   *
   * @throws DomainError unknown_product (404), invalid_cursor (400)
   */
  async getRecentTrades(
    productId: string,
    q: { since?: Date; until?: Date; before?: string; limit: number },
  ): Promise<TradeRow[]> {
    const noTimeFilter =
      q.since === undefined && q.until === undefined && q.before === undefined;
    const since = noTimeFilter
      ? new Date(Date.now() - simSecondsToRealMs(DEFAULT_TRADES_WINDOW_SIM_SECONDS))
      : q.since;
    return withTransaction(async (tx) => {
      await assertProductExists(tx, productId);
      let before: { executedAt: Date; tradeId: string } | undefined;
      if (q.before !== undefined) {
        const cursorTrade = await marketRepository.tradeById(tx, q.before);
        if (cursorTrade === undefined || cursorTrade.productId !== productId) {
          throw domainError(
            "invalid_cursor",
            `El trade ${q.before} no existe para el producto ${productId}.`,
            { field: "before" },
          );
        }
        before = { executedAt: cursorTrade.executedAt, tradeId: cursorTrade.tradeId };
      }
      return marketRepository.recentTradesForProduct(tx, productId, {
        ...(since !== undefined ? { since } : {}),
        ...(q.until !== undefined ? { until: q.until } : {}),
        ...(before !== undefined ? { before } : {}),
        limit: q.limit,
      });
    });
  },
};
