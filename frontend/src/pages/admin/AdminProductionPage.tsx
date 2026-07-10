/**
 * AdminProductionPage — volúmenes productivos: procesos activos y salarios por
 * receta, y unidades producidas (24h) por producto. Solo rol admin.
 *
 * Datos: ["admin","production"] → GET /admin/production
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { AdminProduction, AdminProductionRecipe } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  CategoryBarChart,
  DataTable,
  ErrorBanner,
  StatCard,
  type DataTableColumn,
} from "../../components";
import { fmtMoney, fmtQty } from "../../lib/format";
import styles from "./admin.module.css";
import { toProblem } from "./toProblem";

const REFETCH_MS = 5_000;

const COLUMNS: ReadonlyArray<DataTableColumn<AdminProductionRecipe>> = [
  { key: "recipe_name", header: "Receta", render: (r) => r.recipe_name },
  { key: "output_product_name", header: "Produce", render: (r) => r.output_product_name },
  {
    key: "active_processes",
    header: "Procesos activos",
    align: "right",
    mono: true,
    render: (r) => r.active_processes,
    sortValue: (r) => r.active_processes,
  },
  {
    key: "planned_executions",
    header: "Ejecuciones planif.",
    align: "right",
    mono: true,
    render: (r) => r.planned_executions,
    sortValue: (r) => r.planned_executions,
  },
  {
    key: "wage_paid_cents",
    header: "Salarios pagados",
    align: "right",
    mono: true,
    render: (r) => fmtMoney(r.wage_paid_cents),
    sortValue: (r) => r.wage_paid_cents,
  },
];

export default function AdminProductionPage() {
  const authenticated = useAuth().status === "authenticated";

  const query = useQuery({
    queryKey: ["admin", "production"],
    queryFn: ({ signal }) => api.get<AdminProduction>("/admin/production", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  const producedBars = useMemo(
    () =>
      (query.data?.produced ?? [])
        .filter((p) => p.produced_units_24h > 0)
        .map((p) => ({ name: p.name, produced: p.produced_units_24h })),
    [query.data],
  );

  const totals = useMemo(() => {
    const recipes = query.data?.recipes ?? [];
    return {
      activeProcesses: recipes.reduce((s, r) => s + r.active_processes, 0),
      wages: recipes.reduce((s, r) => s + r.wage_paid_cents, 0),
      produced24h: (query.data?.produced ?? []).reduce((s, p) => s + p.produced_units_24h, 0),
    };
  }, [query.data]);

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Producción</h1>
          <p className={styles.subtitle}>Transformaciones activas y volúmenes producidos.</p>
        </div>
      </div>

      {query.isError ? (
        <ErrorBanner problem={toProblem(query.error)} />
      ) : (
        <>
          <div className={styles.statsGrid}>
            <StatCard label="Procesos activos" value={totals.activeProcesses} />
            <StatCard label="Producido 24h" value={fmtQty(totals.produced24h)} />
            <StatCard label="Salarios pagados" value={fmtMoney(totals.wages)} />
          </div>

          {producedBars.length > 0 && (
            <section className={styles.panel}>
              <CategoryBarChart
                title="Unidades producidas 24h por producto"
                data={producedBars}
                categoryKey="name"
                valueKey="produced"
                valueLabel="Producido"
                valueFormatter={(v) => fmtQty(v)}
              />
            </section>
          )}

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Por receta</h2>
            </div>
            <DataTable
              columns={COLUMNS}
              rows={query.data?.recipes ?? []}
              loading={query.isPending}
              sortable
              rowKey={(r) => r.recipe_id}
              caption="Producción por receta"
              empty="Sin recetas en el catálogo."
            />
          </section>
        </>
      )}
    </div>
  );
}
