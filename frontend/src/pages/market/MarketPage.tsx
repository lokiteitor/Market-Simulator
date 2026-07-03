/**
 * MarketPage [FE6] — pantalla de mercado (design doc §4.4).
 * Rutas: /market (selector) y /market/:productId (detalle).
 *
 * Datos:
 * - ["catalog", "products"]                 → GET /catalog/products (público,
 *                                             estático durante la corrida).
 * - ["self"]                                → GET /agents/me (validaciones del
 *                                             formulario y marcador "tú").
 * - ["market", productId, "top"]            → GET /market/{id}/top
 *                                             (refetchInterval 5 s + WS).
 * - ["market", productId, "trades", win]    → GET /market/{id}/trades
 *                                             (refetchInterval 15 s + WS).
 *
 * El NotificationsProvider [FE2] invalida ["market", productId] al recibir
 * notificaciones (prefix-match), así que top y trades se resincronizan solos.
 */
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  Problem,
  Product,
  SelfState,
  TopOfBook,
  TopOfBookSide,
  Trade,
} from "../../api/types";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  Skeleton,
  type DataTableColumn,
} from "../../components";
import { fmtDateTime, fmtMoney, fmtQty, fmtRelative } from "../../lib/format";
import {
  PRODUCT_CATEGORY_LABEL,
  PRODUCT_CATEGORY_ORDER,
} from "../catalog/labels";
import { QuickOrderForm } from "./QuickOrderForm";
import styles from "./MarketPage.module.css";

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** Error desconocido → Problem RFC 7807 mostrable en ErrorBanner. */
function toProblem(err: unknown): Problem {
  if (err instanceof ApiError) return err.problem;
  return {
    type: "about:blank",
    title: "Error de comunicación",
    status: 0,
    detail: err instanceof Error ? err.message : "Fallo de red desconocido.",
  };
}

const TIME_FMT = new Intl.DateTimeFormat("es", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Solo la hora local (los trades recientes son intradía). */
function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : TIME_FMT.format(new Date(t));
}

/** Ventanas de tiempo (reales) para filtrar trades vía `since`. */
const TRADE_WINDOWS = [
  { key: "default", label: "Ventana por defecto", ms: null },
  { key: "15m", label: "Últimos 15 min", ms: 15 * 60_000 },
  { key: "1h", label: "Última hora", ms: 3_600_000 },
  { key: "6h", label: "Últimas 6 h", ms: 6 * 3_600_000 },
  { key: "24h", label: "Últimas 24 h", ms: 24 * 3_600_000 },
] as const;

type TradeWindowKey = (typeof TRADE_WINDOWS)[number]["key"];

// ---------------------------------------------------------------------------
// Celdas compartidas
// ---------------------------------------------------------------------------

interface AgentCellProps {
  agentId: string;
  selfAgentId: string | null;
}

/** Identidad pública de la contraparte: id truncado + copiar (+ "tú"). */
function AgentCell({ agentId, selfAgentId }: AgentCellProps) {
  return (
    <span className={styles.agentCell}>
      <CopyId id={agentId} />
      {selfAgentId !== null && agentId === selfAgentId && (
        <span className={styles.you}>tú</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Top of book — card de un lado
// ---------------------------------------------------------------------------

interface TopSideCardProps {
  title: string;
  tone: "bid" | "ask";
  side: TopOfBookSide | null | undefined;
  unit: string;
  selfAgentId: string | null;
  emptyText: string;
}

function TopSideCard({
  title,
  tone,
  side,
  unit,
  selfAgentId,
  emptyText,
}: TopSideCardProps) {
  return (
    <div
      className={cx(
        styles.bookCard,
        tone === "bid" ? styles.bookBid : styles.bookAsk,
      )}
    >
      <p className={styles.bookLabel}>{title}</p>
      {side === null || side === undefined ? (
        <p className={styles.bookEmpty}>{emptyText}</p>
      ) : (
        <>
          <p
            className={cx(
              styles.bookPrice,
              tone === "bid" ? styles.priceBid : styles.priceAsk,
            )}
          >
            {fmtMoney(side.price_cents)}
          </p>
          <dl className={styles.bookMeta}>
            <dt>Cantidad</dt>
            <dd className={styles.mono}>
              {fmtQty(side.qty_pending_cent, unit)}
            </dd>
            <dt>Agente</dt>
            <dd>
              <AgentCell agentId={side.agent_id} selfAgentId={selfAgentId} />
            </dd>
            <dt>Orden</dt>
            <dd>
              <CopyId id={side.order_id} />
            </dd>
          </dl>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function MarketPage() {
  const { productId } = useParams<{ productId: string }>();
  const navigate = useNavigate();
  const hasProduct = productId !== undefined;

  // ---- Datos ---------------------------------------------------------------
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
  });

  const topQuery = useQuery({
    queryKey: ["market", productId ?? "", "top"],
    queryFn: ({ signal }) =>
      api.get<TopOfBook>(`/market/${productId}/top`, { signal }),
    enabled: hasProduct,
    refetchInterval: 5_000,
  });

  const [tradeWindow, setTradeWindow] = useState<TradeWindowKey>("default");

  const tradesQuery = useQuery({
    queryKey: ["market", productId ?? "", "trades", tradeWindow],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: "100" });
      const win = TRADE_WINDOWS.find((w) => w.key === tradeWindow);
      if (win !== undefined && win.ms !== null) {
        params.set("since", new Date(Date.now() - win.ms).toISOString());
      }
      return api.get<Trade[]>(
        `/market/${productId}/trades?${params.toString()}`,
        { signal },
      );
    },
    enabled: hasProduct,
    refetchInterval: 15_000,
  });

  const products = useMemo(
    () =>
      [...(productsQuery.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, "es"),
      ),
    [productsQuery.data],
  );

  const product = useMemo(
    () =>
      hasProduct
        ? (products.find((p) => p.product_id === productId) ?? null)
        : null,
    [products, hasProduct, productId],
  );

  const self = selfQuery.data ?? null;
  const selfAgentId = self?.agent.agent_id ?? null;

  // Trades más recientes primero (orden estable independiente del servidor).
  const trades = useMemo(() => {
    const list = [...(tradesQuery.data ?? [])];
    list.sort((a, b) => Date.parse(b.executed_at) - Date.parse(a.executed_at));
    return list;
  }, [tradesQuery.data]);

  const top = topQuery.data ?? null;
  const spreadCents =
    top !== null &&
    top.best_bid !== null &&
    top.best_bid !== undefined &&
    top.best_ask !== null &&
    top.best_ask !== undefined
      ? top.best_ask.price_cents - top.best_bid.price_cents
      : null;

  // ---- Columnas de trades ------------------------------------------------------
  const unit = product?.unit;

  const tradeColumns: Array<DataTableColumn<Trade>> = [
    {
      key: "executed_at",
      header: "Hora",
      mono: true,
      sortValue: (row) => Date.parse(row.executed_at),
      render: (row) => (
        <span title={fmtDateTime(row.executed_at)}>
          {fmtTime(row.executed_at)}
        </span>
      ),
    },
    {
      key: "price_cents",
      header: "Precio",
      align: "right",
      mono: true,
      render: (row) => fmtMoney(row.price_cents),
    },
    {
      key: "qty_executed_cent",
      header: "Cantidad",
      align: "right",
      mono: true,
      render: (row) => fmtQty(row.qty_executed_cent, unit),
    },
    {
      key: "buyer",
      header: "Comprador",
      render: (row) => (
        <AgentCell agentId={row.buyer_agent_id} selfAgentId={selfAgentId} />
      ),
    },
    {
      key: "seller",
      header: "Vendedor",
      render: (row) => (
        <AgentCell agentId={row.seller_agent_id} selfAgentId={selfAgentId} />
      ),
    },
    {
      key: "fees",
      header: "Fees",
      align: "right",
      mono: true,
      sortValue: (row) => row.fee_buyer_cents + row.fee_seller_cents,
      render: (row) => (
        <span
          title={`Comprador ${fmtMoney(row.fee_buyer_cents)} · Vendedor ${fmtMoney(row.fee_seller_cents)}`}
        >
          {fmtMoney(row.fee_buyer_cents + row.fee_seller_cents)}
        </span>
      ),
    },
  ];

  // ---- Estados de página --------------------------------------------------------
  if (productsQuery.isError) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Mercado</h1>
        <ErrorBanner problem={toProblem(productsQuery.error)} />
        <div>
          <button
            type="button"
            className={cx(styles.btn, styles.btnPrimary)}
            onClick={() => void productsQuery.refetch()}
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Cabecera: título + selector de producto */}
      <div className={styles.pageHead}>
        <h1 className={styles.title}>Mercado</h1>
        <div className={styles.picker}>
          <Field label="Producto">
            <select
              value={productId ?? ""}
              onChange={(e) =>
                navigate(
                  e.target.value === ""
                    ? "/market"
                    : `/market/${e.target.value}`,
                )
              }
              disabled={productsQuery.isPending}
            >
              <option value="">— Selecciona un producto —</option>
              {PRODUCT_CATEGORY_ORDER.map((category) => {
                const group = products.filter((p) => p.category === category);
                if (group.length === 0) return null;
                return (
                  <optgroup
                    key={category}
                    label={PRODUCT_CATEGORY_LABEL[category]}
                  >
                    {group.map((p) => (
                      <option key={p.product_id} value={p.product_id}>
                        {p.name} ({p.unit})
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </Field>
        </div>
      </div>

      {!hasProduct ? (
        // ---- /market sin producto: lista/cards del catálogo -------------------
        <section className={styles.panel} aria-labelledby="market-pick">
          <div className={styles.panelHead}>
            <h2 id="market-pick" className={styles.panelTitle}>
              Elige un producto
            </h2>
            <p className={styles.panelHint}>
              Verás su mejor compra/venta, los trades recientes y podrás
              colocar órdenes.
            </p>
          </div>
          {productsQuery.isPending ? (
            <Skeleton rows={4} />
          ) : products.length === 0 ? (
            <EmptyState
              title="Catálogo vacío"
              hint="La corrida aún no tiene productos configurados."
            />
          ) : (
            <div className={styles.productGrid}>
              {products.map((p) => (
                <button
                  key={p.product_id}
                  type="button"
                  className={styles.productCard}
                  onClick={() => navigate(`/market/${p.product_id}`)}
                >
                  <span className={styles.productName}>{p.name}</span>
                  <Badge kind={p.category}>
                    {PRODUCT_CATEGORY_LABEL[p.category]}
                  </Badge>
                  <span className={styles.productUnit}>Unidad: {p.unit}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : productsQuery.isPending ? (
        <div className={styles.panel}>
          <Skeleton rows={5} />
        </div>
      ) : product === null ? (
        <ErrorBanner
          problem={{
            title: "Producto no encontrado",
            status: 404,
            detail:
              "El producto de la URL no existe en el catálogo de esta corrida. Elige otro en el selector.",
          }}
        />
      ) : (
        // ---- /market/:productId ------------------------------------------------
        <div className={styles.layout}>
          <div className={styles.mainCol}>
            {/* Top of book */}
            <section className={styles.panel} aria-labelledby="market-top">
              <div className={styles.panelHead}>
                <h2 id="market-top" className={styles.panelTitle}>
                  Top of book
                </h2>
                <p className={styles.panelHint}>
                  Mejor compra y mejor venta vigentes · se actualiza cada 5 s
                </p>
              </div>
              {topQuery.isPending ? (
                <Skeleton rows={3} />
              ) : topQuery.isError ? (
                <ErrorBanner problem={toProblem(topQuery.error)} />
              ) : (
                top !== null && (
                  <>
                    <div className={styles.bookGrid}>
                      <TopSideCard
                        title="Mejor compra (bid)"
                        tone="bid"
                        side={top.best_bid}
                        unit={product.unit}
                        selfAgentId={selfAgentId}
                        emptyText="Sin órdenes de compra vigentes."
                      />
                      <TopSideCard
                        title="Mejor venta (ask)"
                        tone="ask"
                        side={top.best_ask}
                        unit={product.unit}
                        selfAgentId={selfAgentId}
                        emptyText="Sin órdenes de venta vigentes."
                      />
                    </div>
                    <p className={styles.bookFoot}>
                      {spreadCents !== null && (
                        <>
                          Spread:{" "}
                          <span className={styles.mono}>
                            {fmtMoney(spreadCents)}
                          </span>
                          {" · "}
                        </>
                      )}
                      <span title={fmtDateTime(top.observed_at)}>
                        Observado {fmtRelative(top.observed_at)}
                      </span>
                    </p>
                  </>
                )
              )}
            </section>

            {/* Trades recientes */}
            <section className={styles.panel} aria-labelledby="market-trades">
              <div className={styles.panelHead}>
                <h2 id="market-trades" className={styles.panelTitle}>
                  Trades recientes
                </h2>
                <div className={styles.windowGroup}>
                  <label className={styles.windowLabel} htmlFor="trades-window">
                    Ventana
                  </label>
                  <select
                    id="trades-window"
                    className={styles.windowSelect}
                    value={tradeWindow}
                    onChange={(e) =>
                      setTradeWindow(e.target.value as TradeWindowKey)
                    }
                  >
                    {TRADE_WINDOWS.map((w) => (
                      <option key={w.key} value={w.key}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {tradesQuery.isError ? (
                <ErrorBanner problem={toProblem(tradesQuery.error)} />
              ) : (
                <DataTable
                  columns={tradeColumns}
                  rows={trades}
                  loading={tradesQuery.isPending}
                  sortable
                  rowKey={(row) => row.trade_id}
                  maxHeight="28rem"
                  caption={`Trades recientes de ${product.name}: hora, precio, cantidad, contrapartes y fees`}
                  empty={
                    <EmptyState
                      title="Sin trades recientes"
                      hint="Aún no hay ejecuciones en la ventana seleccionada."
                    />
                  }
                />
              )}
            </section>
          </div>

          {/* Orden rápida */}
          <div className={styles.sideCol}>
            <section className={styles.panel} aria-labelledby="market-ticket">
              <div className={styles.panelHead}>
                <h2 id="market-ticket" className={styles.panelTitle}>
                  Orden rápida
                </h2>
              </div>
              <div className={styles.ticketProduct}>
                <span className={styles.ticketName}>{product.name}</span>
                <Badge kind={product.category}>
                  {PRODUCT_CATEGORY_LABEL[product.category]}
                </Badge>
                <CopyId id={product.product_id} />
              </div>
              <QuickOrderForm product={product} self={self} />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
