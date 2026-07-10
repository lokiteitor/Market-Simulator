/**
 * AdminOverviewPage — KPIs globales del mercado + tendencia (snapshots).
 * Solo rol admin (guardado por ProtectedAdmin en routes.tsx).
 *
 * Datos:
 *  - ["admin","overview"]  → GET /admin/overview (KPIs + desglose por rol)
 *  - ["admin","snapshots"] → GET /admin/snapshots (serie temporal para gráficas)
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { AdminOverview, AdminSnapshotPoint } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  CategoryBarChart,
  ErrorBanner,
  Skeleton,
  StatCard,
  TimeSeriesChart,
} from "../../components";
import { fmtMoney, fmtQty } from "../../lib/format";
import { ROLE_LABEL } from "../auth/roles";
import styles from "./admin.module.css";
import { toProblem } from "./toProblem";

const REFETCH_MS = 5_000;

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

export default function AdminOverviewPage() {
  const authenticated = useAuth().status === "authenticated";

  const overviewQuery = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: ({ signal }) => api.get<AdminOverview>("/admin/overview", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  const snapshotsQuery = useQuery({
    queryKey: ["admin", "snapshots"],
    queryFn: ({ signal }) =>
      api.get<AdminSnapshotPoint[]>("/admin/snapshots?limit=200", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  const roleBars = useMemo(
    () =>
      (overviewQuery.data?.by_role ?? []).map((r) => ({
        role: ROLE_LABEL[r.role] ?? r.role,
        active: r.active_agents,
        capital: r.total_capital_cents,
      })),
    [overviewQuery.data],
  );

  const series = useMemo(
    () =>
      (snapshotsQuery.data ?? []).map((s) => ({
        taken_at: s.taken_at,
        capital: s.total_money_cents,
        fees: s.fees_collected_cents,
        agents: s.active_agents,
      })),
    [snapshotsQuery.data],
  );

  if (overviewQuery.isError) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Panel de monitoreo</h1>
        <ErrorBanner problem={toProblem(overviewQuery.error)} />
      </div>
    );
  }

  const kpis = overviewQuery.data?.kpis;
  const loading = overviewQuery.isPending;

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Panel de monitoreo</h1>
          <p className={styles.subtitle}>
            Estado global del mercado, agentes y producción. Actualización cada 5 s.
          </p>
        </div>
      </div>

      {loading || kpis === undefined ? (
        <Skeleton rows={3} />
      ) : (
        <div className={styles.statsGrid}>
          <StatCard label="Agentes activos" value={kpis.active_agents} hint={`${kpis.bankrupt_agents} en quiebra`} />
          <StatCard label="Capital total" value={fmtMoney(kpis.total_capital_cents)} />
          <StatCard label="Fees recaudados" value={fmtMoney(kpis.fees_collected_cents)} />
          <StatCard label="Procesos activos" value={kpis.active_processes} />
          <StatCard label="Órdenes abiertas" value={kpis.open_orders} />
          <StatCard label="Volumen 24h" value={fmtQty(kpis.trade_volume_24h)} hint={`${kpis.trades_24h} trades`} />
        </div>
      )}

      <div className={styles.chartsRow}>
        <section className={styles.panel}>
          <TimeSeriesChart
            title="Capital y fees (histórico de snapshots)"
            data={series}
            xKey="taken_at"
            series={[
              { key: "capital", label: "Capital total" },
              { key: "fees", label: "Fees" },
            ]}
            valueFormatter={fmtMoney}
            xFormatter={shortTime}
          />
        </section>
        <section className={styles.panel}>
          <TimeSeriesChart
            title="Agentes activos (histórico de snapshots)"
            data={series}
            xKey="taken_at"
            series={[{ key: "agents", label: "Agentes activos" }]}
            xFormatter={shortTime}
          />
        </section>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <h2 className={styles.panelTitle}>Agentes por rol</h2>
        </div>
        <div className={styles.chartsRow}>
          <CategoryBarChart
            title="Activos por rol"
            data={roleBars}
            categoryKey="role"
            valueKey="active"
            valueLabel="Agentes activos"
          />
          <CategoryBarChart
            title="Capital por rol"
            data={roleBars}
            categoryKey="role"
            valueKey="capital"
            valueLabel="Capital"
            valueFormatter={fmtMoney}
          />
        </div>
      </section>
    </div>
  );
}
