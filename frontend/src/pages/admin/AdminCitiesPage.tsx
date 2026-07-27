/**
 * AdminCitiesPage — ciudades e ingreso circular (ADR-020/025). Solo rol admin.
 *
 * Datos: ["admin","cities"] → GET /admin/cities. El ingreso POR ciudad no se
 * persiste (el sweeper solo deja el evento global `city_income_distributed`),
 * por eso el panel muestra el reparto agregado + el peso con el que cada
 * ciudad participa (`population_weight`, reparto exacto al céntimo).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { toProblem } from "../../api/problem";
import type { AdminCities, AdminCityItem } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CategoryBarChart,
  CopyId,
  DataTable,
  ErrorBanner,
  Skeleton,
  StatCard,
  type DataTableColumn,
} from "../../components";
import { fmtBps, fmtMoney } from "../../lib/format";
import styles from "./admin.module.css";

const REFETCH_MS = 5_000;

export default function AdminCitiesPage() {
  const authenticated = useAuth().status === "authenticated";

  const citiesQuery = useQuery({
    queryKey: ["admin", "cities"],
    queryFn: ({ signal }) => api.get<AdminCities>("/admin/cities", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  const data = citiesQuery.data;
  const totalWeight = data?.total_population_weight ?? 0;

  const columns: Array<DataTableColumn<AdminCityItem>> = [
    {
      key: "username",
      header: "Ciudad",
      render: (c) => <span>{c.username}</span>,
      sortValue: (c) => c.username,
    },
    {
      key: "agent_id",
      header: "ID",
      render: (c) => <CopyId id={c.agent_id} />,
    },
    {
      key: "population_weight",
      header: "Peso poblacional",
      align: "right",
      mono: true,
      render: (c) => c.population_weight,
      sortValue: (c) => c.population_weight,
    },
    {
      key: "share",
      header: "% del reparto",
      align: "right",
      mono: true,
      // Mismo redondeo a bps que usa fmtBps: proporción del ingreso que
      // recibe la ciudad en cada reparto del sweeper.
      render: (c) =>
        totalWeight === 0
          ? "—"
          : fmtBps(Math.round((c.population_weight * 10_000) / totalWeight)),
      sortValue: (c) => c.population_weight,
    },
    {
      key: "capital_available_cents",
      header: "Capital disponible",
      align: "right",
      mono: true,
      render: (c) => fmtMoney(c.capital_available_cents),
      sortValue: (c) => c.capital_available_cents,
    },
    {
      key: "capital_reserved_cents",
      header: "Reservado",
      align: "right",
      mono: true,
      render: (c) => fmtMoney(c.capital_reserved_cents),
      sortValue: (c) => c.capital_reserved_cents,
    },
    {
      key: "status",
      header: "Estado",
      render: (c) => (
        <Badge kind={c.status}>
          {c.status === "bankrupt" ? "En quiebra" : "Activa"}
        </Badge>
      ),
    },
  ];

  const capitalBars = useMemo(
    () =>
      (data?.cities ?? [])
        .slice()
        .sort((a, b) => b.capital_available_cents - a.capital_available_cents)
        .slice(0, 15)
        .map((c) => ({
          city: c.username,
          capital: c.capital_available_cents,
        })),
    [data],
  );

  if (citiesQuery.isError) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Ciudades</h1>
        <ErrorBanner problem={toProblem(citiesQuery.error)} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Ciudades</h1>
          <p className={styles.subtitle}>
            Demanda final urbana y flujo circular de ingreso (ADR-020): los
            salarios y la tasa de consumo se reciclan hacia las ciudades,
            ponderados por población. Actualización cada 5 s.
          </p>
        </div>
      </div>

      {citiesQuery.isPending || data === undefined ? (
        <Skeleton rows={3} />
      ) : (
        <>
          <div className={styles.statsGrid}>
            <StatCard
              label="Ciudades"
              value={data.city_count}
              hint={`peso poblacional total: ${data.total_population_weight}`}
            />
            <StatCard
              label="Ingreso pendiente"
              value={fmtMoney(data.pending_income_cents)}
              hint="en tránsito, aún sin repartir"
            />
            <StatCard
              label="Pendiente por salarios"
              value={fmtMoney(data.pending_income_by_source.wage_cents)}
              hint="reciclado de la producción"
            />
            <StatCard
              label="Pendiente por tasa"
              value={fmtMoney(data.pending_income_by_source.tax_cents)}
              hint="parte urbana del fee del matching"
            />
            <StatCard
              label="Repartido 24h"
              value={fmtMoney(data.distributed_income_24h_cents)}
              hint={`${data.distributions_24h} repartos del sweeper`}
            />
          </div>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Reparto por ciudad</h2>
            </div>
            <DataTable
              columns={columns}
              rows={data.cities}
              sortable
              rowKey={(c) => c.agent_id}
              caption="Ciudades con su peso poblacional, porcentaje del reparto y capital"
              empty="Esta corrida no tiene ciudades sembradas."
            />
          </section>

          {capitalBars.length > 0 && (
            <section className={styles.panel}>
              <CategoryBarChart
                title="Capital disponible por ciudad (top 15)"
                data={capitalBars}
                categoryKey="city"
                valueKey="capital"
                valueLabel="Capital"
                valueFormatter={fmtMoney}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
