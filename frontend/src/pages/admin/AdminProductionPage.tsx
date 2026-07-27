/**
 * AdminProductionPage — volúmenes productivos: procesos activos y salarios por
 * receta (filtrables por tipo de instalación, ADR-021), unidades producidas
 * (24h) por producto con la electricidad destacada (ADR-024) y estado de los
 * yacimientos finitos (ADR-023). Solo rol admin.
 *
 * Datos: ["admin","production"]          → GET /admin/production
 *        ["catalog","deposits"]          → GET /catalog/deposits (público, dinámico)
 *        ["catalog","recipes"]           → GET /catalog/recipes (mapa receta→tipo)
 *        ["catalog","installation-types"]→ GET /catalog/installation-types
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { toProblem } from "../../api/problem";
import type {
  AdminProduction,
  AdminProductionRecipe,
  Deposit,
  InstallationType,
  Product,
  Recipe,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CategoryBarChart,
  DataTable,
  ErrorBanner,
  ProgressBar,
  StatCard,
  type DataTableColumn,
} from "../../components";
import { fmtBps, fmtMoney, fmtQty } from "../../lib/format";
import styles from "./admin.module.css";

const REFETCH_MS = 5_000;
const ELECTRICITY_PRODUCT_KEY = "electricidad";
const GENERATION_TYPE_KEY = "generacion";

export default function AdminProductionPage() {
  const authenticated = useAuth().status === "authenticated";

  const query = useQuery({
    queryKey: ["admin", "production"],
    queryFn: ({ signal }) => api.get<AdminProduction>("/admin/production", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  // Yacimientos (ADR-023): misma query pública que catálogo/mercado (caché
  // compartida); dinámica, sin staleTime.
  const depositsQuery = useQuery({
    queryKey: ["catalog", "deposits"],
    queryFn: ({ signal }) =>
      api.get<Deposit[]>("/catalog/deposits", { signal, auth: false }),
    refetchInterval: REFETCH_MS,
  });
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });
  const productNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p.name);
    return map;
  }, [productsQuery.data]);

  // Catálogo estático para mapear receta → tipo de instalación (ADR-021).
  const recipesQuery = useQuery({
    queryKey: ["catalog", "recipes"],
    queryFn: ({ signal }) =>
      api.get<Recipe[]>("/catalog/recipes", { signal, auth: false }),
    staleTime: Infinity,
  });
  const typesQuery = useQuery({
    queryKey: ["catalog", "installation-types"],
    queryFn: ({ signal }) =>
      api.get<InstallationType[]>("/catalog/installation-types", {
        signal,
        auth: false,
      }),
    staleTime: Infinity,
  });

  const typeById = useMemo(() => {
    const map = new Map<string, InstallationType>();
    for (const t of typesQuery.data ?? []) map.set(t.installation_type_id, t);
    return map;
  }, [typesQuery.data]);
  const typeByRecipeId = useMemo(() => {
    const map = new Map<string, InstallationType>();
    for (const r of recipesQuery.data ?? []) {
      const type = typeById.get(r.installation_type_id);
      if (type !== undefined) map.set(r.recipe_id, type);
    }
    return map;
  }, [recipesQuery.data, typeById]);

  const [typeFilter, setTypeFilter] = useState("");

  const recipeColumns = useMemo<
    ReadonlyArray<DataTableColumn<AdminProductionRecipe>>
  >(
    () => [
      { key: "recipe_name", header: "Receta", render: (r) => r.recipe_name },
      {
        key: "installation",
        header: "Instalación",
        render: (r) => {
          const type = typeByRecipeId.get(r.recipe_id);
          if (type === undefined) return "—";
          return (
            <Badge kind="neutral">
              {type.key === GENERATION_TYPE_KEY ? `⚡ ${type.name}` : type.name}
            </Badge>
          );
        },
        sortValue: (r) => typeByRecipeId.get(r.recipe_id)?.name ?? "",
      },
      {
        key: "output_product_name",
        header: "Produce",
        render: (r) => r.output_product_name,
      },
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
    ],
    [typeByRecipeId],
  );

  const filteredRecipes = useMemo(() => {
    const all = query.data?.recipes ?? [];
    if (typeFilter === "") return all;
    return all.filter(
      (r) => typeByRecipeId.get(r.recipe_id)?.installation_type_id === typeFilter,
    );
  }, [query.data, typeFilter, typeByRecipeId]);

  // Electricidad producida 24h (ADR-024): el pulso de la fase de energía.
  const electricityProduced24h = useMemo(() => {
    const product = (productsQuery.data ?? []).find(
      (p) => p.key === ELECTRICITY_PRODUCT_KEY,
    );
    if (product === undefined) return null;
    return (
      (query.data?.produced ?? []).find(
        (p) => p.product_id === product.product_id,
      )?.produced_units_24h ?? 0
    );
  }, [productsQuery.data, query.data]);

  const depositColumns = useMemo<
    ReadonlyArray<DataTableColumn<Deposit>>
  >(
    () => [
      {
        key: "product",
        header: "Producto",
        render: (d) => productNameById.get(d.product_id) ?? d.product_key,
        sortValue: (d) => productNameById.get(d.product_id) ?? d.product_key,
      },
      {
        key: "remaining",
        header: "Restante / inicial",
        render: (d) => (
          <span className={styles.depositCell}>
            <span>
              {fmtQty(d.qty_remaining_cent)} / {fmtQty(d.qty_initial_cent)}
            </span>
            <ProgressBar
              value={d.qty_remaining_cent}
              max={d.qty_initial_cent}
              label={`Remanente de ${productNameById.get(d.product_id) ?? d.product_key}`}
            />
          </span>
        ),
        sortValue: (d) => d.qty_remaining_cent,
      },
      {
        key: "yield_bps",
        header: "Rendimiento",
        align: "right",
        mono: true,
        render: (d) => fmtBps(d.yield_bps),
        sortValue: (d) => d.yield_bps,
      },
      {
        key: "state",
        header: "Estado",
        render: (d) =>
          d.yield_bps === 0 ? (
            <Badge kind="expired">Agotado</Badge>
          ) : (
            <Badge kind="active">Activo</Badge>
          ),
        sortValue: (d) => (d.yield_bps === 0 ? 0 : 1),
      },
    ],
    [productNameById],
  );

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
            {electricityProduced24h !== null && (
              <StatCard
                label="⚡ Electricidad 24h"
                value={fmtQty(electricityProduced24h, "kWh")}
                hint="fase de energía (ADR-024)"
              />
            )}
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
              <label className={styles.filterLabel}>
                Tipo de instalación
                <select
                  className={styles.select}
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="">Todos</option>
                  {(typesQuery.data ?? []).map((t) => (
                    <option
                      key={t.installation_type_id}
                      value={t.installation_type_id}
                    >
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <DataTable
              columns={recipeColumns}
              rows={filteredRecipes}
              loading={query.isPending}
              sortable
              rowKey={(r) => r.recipe_id}
              caption="Producción por receta con su tipo de instalación"
              empty="Sin recetas con este filtro."
            />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Yacimientos</h2>
              <p className={styles.panelHint}>
                Recursos no renovables (ADR-023): remanente y rendimiento
                actuales
              </p>
            </div>
            {depositsQuery.isError ? (
              <ErrorBanner problem={toProblem(depositsQuery.error)} />
            ) : (
              <DataTable
                columns={depositColumns}
                rows={depositsQuery.data ?? []}
                loading={depositsQuery.isPending}
                sortable
                rowKey={(d) => d.product_id}
                caption="Yacimientos finitos con remanente y rendimiento"
                empty="Esta corrida no tiene recursos finitos configurados."
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
