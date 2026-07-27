/**
 * AdminBankPage — moneda y banco central (patrón oro) para el panel admin.
 *
 * Complementa a /bank (que ya muestra la política y la ventanilla): aquí va la
 * visión macro — masa monetaria y fees en el tiempo (snapshots), emisión neta
 * frente a capacidad respaldada y reservas del banco.
 *
 * Datos:
 *  - ["bank"]              → GET /bank (autenticado; 409 = sin patrón oro)
 *  - ["admin","snapshots"] → GET /admin/snapshots (serie temporal)
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import { toProblem } from "../../api/problem";
import type { AdminSnapshotPoint, BankInfo } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  EmptyState,
  ErrorBanner,
  Skeleton,
  StatCard,
  TimeSeriesChart,
} from "../../components";
import { fmtBps, fmtMoney, fmtQty } from "../../lib/format";
import styles from "./admin.module.css";

const REFETCH_MS = 5_000;

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

export default function AdminBankPage() {
  const authenticated = useAuth().status === "authenticated";

  const bankQuery = useQuery({
    queryKey: ["bank"],
    queryFn: ({ signal }) => api.get<BankInfo>("/bank", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
    // 409 no_gold_standard es estado terminal de la corrida, no fallo transitorio.
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 409) && failureCount < 3,
  });

  const snapshotsQuery = useQuery({
    queryKey: ["admin", "snapshots"],
    queryFn: ({ signal }) =>
      api.get<AdminSnapshotPoint[]>("/admin/snapshots?limit=200", { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
  });

  const bank = bankQuery.data ?? null;

  const series = useMemo(
    () =>
      (snapshotsQuery.data ?? []).map((s) => ({
        taken_at: s.taken_at,
        money: s.total_money_cents,
        fees: s.fees_collected_cents,
      })),
    [snapshotsQuery.data],
  );

  const netIssuedCents =
    bank !== null ? bank.money_issued_cents - bank.money_burned_cents : 0;
  // Utilización de la capacidad respaldada: emisión neta / capacidad, en bps.
  const utilizationBps =
    bank !== null && bank.issuance_capacity_cents > 0
      ? Math.round((netIssuedCents * 10_000) / bank.issuance_capacity_cents)
      : null;

  const noGoldStandard =
    bankQuery.isError &&
    bankQuery.error instanceof ApiError &&
    bankQuery.error.status === 409;

  if (bankQuery.isError && !noGoldStandard) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Moneda</h1>
        <ErrorBanner problem={toProblem(bankQuery.error)} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Moneda</h1>
          <p className={styles.subtitle}>
            Masa monetaria, emisión respaldada por oro y reservas del banco
            central. Actualización cada 5 s.
          </p>
        </div>
      </div>

      {noGoldStandard ? (
        <EmptyState
          title="Sin patrón oro"
          hint="Esta corrida no tiene banco central sembrado."
        />
      ) : bankQuery.isPending || bank === null ? (
        <Skeleton rows={3} />
      ) : (
        <>
          <div className={styles.statsGrid}>
            <StatCard
              label="Masa monetaria"
              value={
                series.length > 0
                  ? fmtMoney(series[series.length - 1]!.money)
                  : "—"
              }
              hint="último snapshot (capital total del sistema)"
            />
            <StatCard
              label="Emisión neta"
              value={fmtMoney(netIssuedCents)}
              hint={`emitido ${fmtMoney(bank.money_issued_cents)} − destruido ${fmtMoney(bank.money_burned_cents)}`}
            />
            <StatCard
              label="Capacidad de emisión"
              value={fmtMoney(bank.issuance_capacity_cents)}
              hint={
                utilizationBps !== null
                  ? `utilización: ${fmtBps(utilizationBps)}`
                  : "sin oro que la respalde"
              }
            />
            <StatCard
              label="Capital del banco"
              value={fmtMoney(bank.bank_capital_available_cents)}
              hint="incluye fees aún no materializados (ADR-019)"
            />
            <StatCard
              label="Oro del banco"
              value={fmtQty(bank.bank_gold_available_cent)}
              hint={`paridad ${fmtMoney(bank.parity_cents_per_unit)} · cobertura ${fmtBps(bank.coverage_ratio_bps)}`}
            />
            <StatCard
              label="Yacimiento de oro"
              value={
                bank.deposit_remaining_cent !== null
                  ? fmtQty(bank.deposit_remaining_cent)
                  : "—"
              }
              hint="oro minable restante (ADR-023)"
            />
          </div>

          <div className={styles.chartsRow}>
            <section className={styles.panel}>
              <TimeSeriesChart
                title="Masa monetaria (histórico de snapshots)"
                data={series}
                xKey="taken_at"
                series={[{ key: "money", label: "Masa monetaria" }]}
                valueFormatter={fmtMoney}
                xFormatter={shortTime}
              />
            </section>
            <section className={styles.panel}>
              <TimeSeriesChart
                title="Fees acumulados (histórico de snapshots)"
                data={series}
                xKey="taken_at"
                series={[{ key: "fees", label: "Fees" }]}
                valueFormatter={fmtMoney}
                xFormatter={shortTime}
              />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
