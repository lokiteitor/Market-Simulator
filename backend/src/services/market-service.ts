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
   * Trades recientes del producto. Sin `since`, aplica la ventana por defecto
   * del último día simulado (86 400 s sim → reales vía factor de simulación).
   *
   * @throws DomainError unknown_product (404)
   */
  async getRecentTrades(
    productId: string,
    q: { since?: Date; limit: number },
  ): Promise<TradeRow[]> {
    const since =
      q.since ??
      new Date(Date.now() - simSecondsToRealMs(DEFAULT_TRADES_WINDOW_SIM_SECONDS));
    return withTransaction(async (tx) => {
      await assertProductExists(tx, productId);
      return marketRepository.recentTradesForProduct(tx, productId, since, q.limit);
    });
  },
};
