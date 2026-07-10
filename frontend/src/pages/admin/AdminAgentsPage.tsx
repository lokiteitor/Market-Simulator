/**
 * AdminAgentsPage — listado paginado de agentes/bots de mercado, con filtros
 * por rol y estado. Solo rol admin.
 *
 * Datos: ["admin","agents", role, status, offset] → GET /admin/agents?…
 */
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import type { AdminAgentItem, AdminAgentsPage, AgentRole } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CopyId,
  DataTable,
  ErrorBanner,
  type DataTableColumn,
} from "../../components";
import { fmtMoney, fmtRelative } from "../../lib/format";
import { ROLE_LABEL } from "../auth/roles";
import styles from "./admin.module.css";
import { toProblem } from "./toProblem";

const PAGE_SIZE = 25;
const REFETCH_MS = 5_000;

const ROLE_OPTIONS: ReadonlyArray<{ value: AgentRole | ""; label: string }> = [
  { value: "", label: "Todos los roles" },
  { value: "primary_producer", label: ROLE_LABEL.primary_producer },
  { value: "transformer", label: ROLE_LABEL.transformer },
  { value: "consumer", label: ROLE_LABEL.consumer },
  { value: "trader", label: ROLE_LABEL.trader },
];

const STATUS_OPTIONS = [
  { value: "", label: "Todos los estados" },
  { value: "active", label: "Activo" },
  { value: "bankrupt", label: "En quiebra" },
] as const;

const COLUMNS: ReadonlyArray<DataTableColumn<AdminAgentItem>> = [
  {
    key: "username",
    header: "Usuario",
    render: (a) => <span>{a.username}</span>,
  },
  {
    key: "agent_id",
    header: "ID",
    render: (a) => <CopyId id={a.agent_id} />,
  },
  {
    key: "role",
    header: "Rol",
    render: (a) => <Badge kind={a.role}>{ROLE_LABEL[a.role] ?? a.role}</Badge>,
  },
  {
    key: "status",
    header: "Estado",
    render: (a) => (
      <Badge kind={a.status}>{a.status === "bankrupt" ? "En quiebra" : "Activo"}</Badge>
    ),
  },
  {
    key: "capital_available_cents",
    header: "Capital disponible",
    align: "right",
    mono: true,
    render: (a) => fmtMoney(a.capital_available_cents),
    sortValue: (a) => a.capital_available_cents,
  },
  {
    key: "capital_reserved_cents",
    header: "Reservado",
    align: "right",
    mono: true,
    render: (a) => fmtMoney(a.capital_reserved_cents),
    sortValue: (a) => a.capital_reserved_cents,
  },
  {
    key: "registered_at",
    header: "Registrado",
    render: (a) => fmtRelative(a.registered_at),
    sortValue: (a) => a.registered_at,
  },
];

export default function AdminAgentsPage() {
  const authenticated = useAuth().status === "authenticated";
  const [role, setRole] = useState<AgentRole | "">("");
  const [status, setStatus] = useState<"" | "active" | "bankrupt">("");
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (role !== "") params.set("role", role);
  if (status !== "") params.set("status", status);

  const query = useQuery({
    queryKey: ["admin", "agents", role, status, offset],
    queryFn: ({ signal }) =>
      api.get<AdminAgentsPage>(`/admin/agents?${params.toString()}`, { signal }),
    enabled: authenticated,
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  });

  const page = query.data;
  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Agentes</h1>
          <p className={styles.subtitle}>Participantes del mercado (bots y humanos).</p>
        </div>
      </div>

      <section className={styles.panel}>
        <div className={styles.filters}>
          <label className={styles.filterLabel}>
            Rol
            <select
              className={styles.select}
              value={role}
              onChange={(e) => {
                setRole(e.target.value as AgentRole | "");
                setOffset(0);
              }}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filterLabel}>
            Estado
            <select
              className={styles.select}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as "" | "active" | "bankrupt");
                setOffset(0);
              }}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {query.isError ? (
          <ErrorBanner problem={toProblem(query.error)} />
        ) : (
          <>
            <DataTable
              columns={COLUMNS}
              rows={page?.items ?? []}
              loading={query.isPending}
              sortable
              rowKey={(a) => a.agent_id}
              caption="Listado de agentes"
              empty="No hay agentes con estos filtros."
            />
            <div className={styles.pager}>
              <span className={styles.pagerInfo}>
                {total === 0 ? "Sin resultados" : `${from}–${to} de ${total}`}
              </span>
              <div className={styles.pagerButtons}>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!canPrev}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className={styles.btn}
                  disabled={!canNext}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                >
                  Siguiente
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
