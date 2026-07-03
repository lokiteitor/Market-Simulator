/**
 * HistoryPage [FE7] — historial del agente con tabs Trades / Eventos
 * (design doc §4.5, contrato §history).
 *
 * Datos (paginación por cursor con useInfiniteQuery + botón "Cargar más"):
 * - ["history", "trades"] → GET /history/trades (trades donde el agente fue
 *   comprador o vendedor; muestra lado propio, fees propios y contraparte).
 * - ["history", "events"] → GET /history/events (event_log propio; tipo
 *   legible con Badge + payload resumido y JSON expandible).
 * - ["self"] / ["catalog","products"] → identidad propia (para el lado del
 *   trade) y nombres/unidades de productos.
 *
 * Cada tab solo se consulta cuando está activo (`enabled`); el prefix
 * ["history"] coincide con las invalidaciones del proveedor WS.
 */
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  EventEntry,
  EventPage,
  Problem,
  Product,
  SelfState,
  Trade,
  TradePage,
} from "../../api/types";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  type DataTableColumn,
} from "../../components";
import { fmtDateTime, fmtMoney, fmtQty, truncId } from "../../lib/format";
import { notionalCents } from "../orders/orderFormLogic";
import { eventTypeBadge, eventTypeLabel, summarizeEventPayload } from "./eventLabels";
import styles from "./HistoryPage.module.css";

const PAGE_LIMIT = 50;

type HistoryTab = "trades" | "events";

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

function buildCursorQuery(cursor: string | null): string {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_LIMIT));
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export default function HistoryPage() {
  const [tab, setTab] = useState<HistoryTab>("trades");

  // ---- Datos de apoyo ---------------------------------------------------------
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
  });
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const myAgentId = selfQuery.data?.agent.agent_id ?? null;

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;

  // ---- Tabs (solo se consulta el activo) ------------------------------------------
  const tradesQuery = useInfiniteQuery({
    queryKey: ["history", "trades"],
    queryFn: ({ pageParam, signal }) =>
      api.get<TradePage>(`/history/trades?${buildCursorQuery(pageParam)}`, {
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled: tab === "trades",
  });

  const eventsQuery = useInfiniteQuery({
    queryKey: ["history", "events"],
    queryFn: ({ pageParam, signal }) =>
      api.get<EventPage>(`/history/events?${buildCursorQuery(pageParam)}`, {
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled: tab === "events",
  });

  const trades = useMemo(
    () => tradesQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [tradesQuery.data],
  );
  const events = useMemo(
    () => eventsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [eventsQuery.data],
  );

  // ---- Columnas: trades --------------------------------------------------------------
  const tradeColumns: Array<DataTableColumn<Trade>> = [
    {
      key: "executed_at",
      header: "Fecha",
      mono: true,
      sortValue: (row) => Date.parse(row.executed_at),
      render: (row) => fmtDateTime(row.executed_at),
    },
    {
      key: "trade_id",
      header: "Trade",
      render: (row) => <CopyId id={row.trade_id} />,
    },
    {
      key: "product",
      header: "Producto",
      sortValue: (row) => productName(row.product_id),
      render: (row) => productName(row.product_id),
    },
    {
      key: "side",
      header: "Mi lado",
      render: (row) =>
        row.buyer_agent_id === myAgentId ? (
          <Badge kind="buy">Compra</Badge>
        ) : (
          <Badge kind="sell">Venta</Badge>
        ),
    },
    {
      key: "qty_executed_cent",
      header: "Cantidad",
      align: "right",
      mono: true,
      render: (row) =>
        fmtQty(row.qty_executed_cent, productUnit(row.product_id)),
    },
    {
      key: "price_cents",
      header: "Precio",
      align: "right",
      mono: true,
      render: (row) => fmtMoney(row.price_cents),
    },
    {
      key: "notional",
      header: "Importe",
      align: "right",
      mono: true,
      sortValue: (row) => notionalCents(row.qty_executed_cent, row.price_cents),
      render: (row) =>
        fmtMoney(notionalCents(row.qty_executed_cent, row.price_cents)),
    },
    {
      key: "fee",
      header: "Mi fee",
      align: "right",
      mono: true,
      sortValue: (row) =>
        row.buyer_agent_id === myAgentId
          ? row.fee_buyer_cents
          : row.fee_seller_cents,
      render: (row) => (
        <span
          title={`Fee comprador ${fmtMoney(row.fee_buyer_cents)} · fee vendedor ${fmtMoney(row.fee_seller_cents)}`}
        >
          {fmtMoney(
            row.buyer_agent_id === myAgentId
              ? row.fee_buyer_cents
              : row.fee_seller_cents,
          )}
        </span>
      ),
    },
    {
      key: "counterparty",
      header: "Contraparte",
      render: (row) => (
        <CopyId
          id={
            row.buyer_agent_id === myAgentId
              ? row.seller_agent_id
              : row.buyer_agent_id
          }
        />
      ),
    },
  ];

  // ---- Columnas: eventos ----------------------------------------------------------------
  const eventColumns: Array<DataTableColumn<EventEntry>> = [
    {
      key: "occurred_at",
      header: "Fecha",
      mono: true,
      sortValue: (row) => Date.parse(row.occurred_at),
      render: (row) => fmtDateTime(row.occurred_at),
    },
    {
      key: "event_type",
      header: "Tipo",
      sortValue: (row) => eventTypeLabel(row.event_type),
      render: (row) => (
        <Badge kind={eventTypeBadge(row.event_type)}>
          {eventTypeLabel(row.event_type)}
        </Badge>
      ),
    },
    {
      key: "event_id",
      header: "Evento",
      render: (row) => <CopyId id={row.event_id} />,
    },
    {
      key: "payload",
      header: "Detalle",
      render: (row) => (
        <div className={styles["eventDetail"]}>
          <span>{summarizeEventPayload(row.payload, productName)}</span>
          <details className={styles["payloadDetails"]}>
            <summary className={styles["payloadSummary"]}>
              Payload JSON
            </summary>
            <pre className={styles["payloadJson"]}>
              {JSON.stringify(row.payload, null, 2)}
            </pre>
          </details>
        </div>
      ),
    },
  ];

  // ---- Render por tab ------------------------------------------------------------------------
  const active = tab === "trades" ? tradesQuery : eventsQuery;

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Historial</h1>
      </div>

      {/* Tabs */}
      <div className={styles["tabs"]} role="tablist" aria-label="Historial">
        <button
          type="button"
          role="tab"
          id="history-tab-trades"
          aria-selected={tab === "trades"}
          aria-controls="history-panel-trades"
          className={cx(
            styles["tab"],
            tab === "trades" ? styles["tabActive"] : undefined,
          )}
          onClick={() => setTab("trades")}
        >
          Trades
        </button>
        <button
          type="button"
          role="tab"
          id="history-tab-events"
          aria-selected={tab === "events"}
          aria-controls="history-panel-events"
          className={cx(
            styles["tab"],
            tab === "events" ? styles["tabActive"] : undefined,
          )}
          onClick={() => setTab("events")}
        >
          Eventos
        </button>
      </div>

      {active.isError ? (
        <>
          <ErrorBanner problem={toProblem(active.error)} />
          <div>
            <button
              type="button"
              className={cx(styles["btn"], styles["btnPrimary"])}
              onClick={() => void active.refetch()}
            >
              Reintentar
            </button>
          </div>
        </>
      ) : tab === "trades" ? (
        <section
          className={styles["panel"]}
          role="tabpanel"
          id="history-panel-trades"
          aria-labelledby="history-tab-trades"
        >
          <div className={styles["panelHead"]}>
            <h2 className={styles["panelTitle"]}>Trades</h2>
            <p className={styles["panelHint"]}>
              {trades.length > 0
                ? `${trades.length} ${trades.length === 1 ? "trade cargado" : "trades cargados"}`
                : "Trades donde participaste como comprador o vendedor"}
            </p>
          </div>
          <DataTable
            columns={tradeColumns}
            rows={trades}
            loading={tradesQuery.isPending}
            sortable
            rowKey={(row) => row.trade_id}
            caption="Historial de trades del agente con cantidad, precio, fees y contraparte"
            empty={
              <EmptyState
                title="Sin trades todavía"
                hint="Cuando una orden tuya se ejecute, el trade aparecerá aquí."
              />
            }
          />
          <div className={styles["loadMoreRow"]}>
            {tradesQuery.hasNextPage ? (
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => void tradesQuery.fetchNextPage()}
                disabled={tradesQuery.isFetchingNextPage}
              >
                {tradesQuery.isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </button>
            ) : (
              trades.length > 0 && (
                <p className={styles["subtle"]}>No hay más trades.</p>
              )
            )}
          </div>
        </section>
      ) : (
        <section
          className={styles["panel"]}
          role="tabpanel"
          id="history-panel-events"
          aria-labelledby="history-tab-events"
        >
          <div className={styles["panelHead"]}>
            <h2 className={styles["panelTitle"]}>Eventos</h2>
            <p className={styles["panelHint"]}>
              {events.length > 0
                ? `${events.length} ${events.length === 1 ? "evento cargado" : "eventos cargados"}`
                : "Línea de tiempo completa del agente (event log)"}
            </p>
          </div>
          <DataTable
            columns={eventColumns}
            rows={events}
            loading={eventsQuery.isPending}
            rowKey={(row) => row.event_id}
            caption="Historial de eventos del agente con tipo legible y payload resumido"
            empty={
              <EmptyState
                title="Sin eventos todavía"
                hint="Cada acción relevante del agente queda registrada aquí."
              />
            }
          />
          <div className={styles["loadMoreRow"]}>
            {eventsQuery.hasNextPage ? (
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => void eventsQuery.fetchNextPage()}
                disabled={eventsQuery.isFetchingNextPage}
              >
                {eventsQuery.isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </button>
            ) : (
              events.length > 0 && (
                <p className={styles["subtle"]}>No hay más eventos.</p>
              )
            )}
          </div>
        </section>
      )}
    </div>
  );
}
