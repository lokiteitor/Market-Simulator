/**
 * AdminMarketPage — estado global del mercado por producto: top-of-book,
 * profundidad, inventario del sistema y volumen/VWAP 24h. Solo rol admin.
 *
 * Datos: ["admin","market"] → GET /admin/market
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { AdminMarketProduct } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  CategoryBarChart,
  DataTable,
  ErrorBanner,
  type DataTableColumn,
} from "../../components";
import { fmtMoney, fmtQty } from "../../lib/format";
import styles from "./admin.module.css";
import { toProblem } from "./toProblem";

const REFETCH_MS = 5_000;

function money(c: number | null): string {
  return c === null ? "—" : fmtMoney(c);
}

const COLUMNS: ReadonlyArray<DataTableColumn<AdminMarketProduct>> = [
  { key: "name", header: "Producto", render: (p) => p.name },
  {
    key: "best_bid_cents",
    header: "Mejor bid",
    align: "right",
    mono: true,
    render: (p) => money(p.best_bid_cents),
    sortValue: (p) => p.best_bid_cents ?? -1,
  },
  {
    key: "best_ask_cents",
    header: "Mejor ask",
    align: "right",
    mono: true,
    render: (p) => money(p.best_ask_cents),
    sortValue: (p) => p.best_ask_cents ?? Number.MAX_SAFE_INTEGER,
  },
  {
    key: "bid_depth",
    header: "Prof. compra",
    align: "right",
    mono: true,
    render: (p) => fmtQty(p.bid_depth),
    sortValue: (p) => p.bid_depth,
  },
  {
    key: "ask_depth",
    header: "Prof. venta",
    align: "right",
    mono: true,
    render: (p) => fmtQty(p.ask_depth),
    sortValue: (p) => p.ask_depth,
  },
  {
    key: "total_inventory",
    header: "Inventario",
    align: "right",
    mono: true,
    render: (p) => fmtQty(p.total_inventory, p.unit),
    sortValue: (p) => p.total_inventory,
  },
  {
    key: "trade_volume_24h",
    header: "Volumen 24h",
    align: "right",
    mono: true,
    render: (p) => fmtQty(p.trade_volume_24h),
    sortValue: (p) => p.trade_volume_24h,
  },
  {
    key: "vwap_24h_cents",
    header: "VWAP 24h",
    align: "right",
    mono: true,
    render: (p) => money(p.vwap_24h_cents),
    sortValue: (p) => p.vwap_24h_cents ?? -1,
  },
  {
    key: "trades_24h",
    header: "Trades 24h",
    align: "right",
    mono: true,
    render: (p) => p.trades_24h,
    sortValue: (p) => p.trades_24h,
  },
];

export default function AdminMarketPage() {
  const authenticated = useAuth().status === "authenticated";

  const query = useQuery({
    queryKey: ["admin", "market"],
    queryFn: ({ signal }) => api.get<AdminMarketProduct[]>("/admin/market", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  const volumeBars = useMemo(
    () =>
      (query.data ?? [])
        .filter((p) => p.trade_volume_24h > 0)
        .map((p) => ({ name: p.name, volume: p.trade_volume_24h })),
    [query.data],
  );

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Mercado</h1>
          <p className={styles.subtitle}>Libro global, inventario y actividad por producto.</p>
        </div>
      </div>

      {query.isError ? (
        <ErrorBanner problem={toProblem(query.error)} />
      ) : (
        <>
          {volumeBars.length > 0 && (
            <section className={styles.panel}>
              <CategoryBarChart
                title="Volumen negociado 24h por producto"
                data={volumeBars}
                categoryKey="name"
                valueKey="volume"
                valueLabel="Volumen"
                valueFormatter={(v) => fmtQty(v)}
              />
            </section>
          )}
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Por producto</h2>
            </div>
            <DataTable
              columns={COLUMNS}
              rows={query.data ?? []}
              loading={query.isPending}
              sortable
              rowKey={(p) => p.product_id}
              caption="Estado del mercado por producto"
              empty="Sin productos en el catálogo."
            />
          </section>
        </>
      )}
    </div>
  );
}
