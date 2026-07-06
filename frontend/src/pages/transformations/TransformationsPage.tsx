/**
 * TransformationsPage [FE7] — capacidades y procesos de transformación
 * (design doc §4.3, contrato §transformations).
 *
 * Datos:
 * - ["self"] → GET /agents/me (capacidades usadas/total, inventario, capital).
 * - ["catalog", ...] → nombres de recetas/productos, duración y salario.
 * - ["processes", "list", statuses] → GET /transformations (paginación por
 *   cursor vía useInfiniteQuery + "Cargar más"; sin filtro = todos).
 *
 * Acciones:
 * - Iniciar proceso → StartProcessModal (POST /transformations).
 * - Cancelar (solo running) → Modal con advertencia SIN reembolso
 *   → DELETE /transformations/{id} → invalidate ["self"] + ["processes"].
 *
 * El progreso de procesos running se re-renderiza con tick de 1 s contra
 * `expected_end_at`; los estados terminales muestran Badge y fecha de fin.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  LotConsumption,
  Problem,
  ProcessStatus,
  Product,
  Recipe,
  SelfState,
  TransformationPage,
  TransformationProcess,
  TransformationProcessDetail,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  Modal,
  ProgressBar,
  Skeleton,
  showToast,
  type DataTableColumn,
} from "../../components";
import {
  fmtDateTime,
  fmtMoney,
  fmtQty,
  fmtRelative,
  truncId,
} from "../../lib/format";
import { fmtDurationSeconds, realDurationSimHint } from "../market/simTime";
import { PROCESS_STATUS_BADGE, PROCESS_STATUS_LABEL } from "./processLabels";
import { availableSlots } from "./transformMath";
import { StartProcessModal } from "./StartProcessModal";
import styles from "./TransformationsPage.module.css";

const PAGE_LIMIT = 50;

/** Orden canónico de estados (chips y queryKey estable). */
const ALL_STATUSES: readonly ProcessStatus[] = [
  "running",
  "completed",
  "cancelled",
];

/** Etiquetas en plural para los chips de filtro. */
const STATUS_PLURAL: Record<ProcessStatus, string> = {
  running: "En curso",
  completed: "Completados",
  cancelled: "Cancelados",
};

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

/** Query string de GET /transformations (status repetible + cursor). */
function buildProcessesQuery(
  statuses: readonly ProcessStatus[],
  cursor: string | null,
): string {
  const params = new URLSearchParams();
  for (const s of statuses) params.append("status", s);
  params.set("limit", String(PAGE_LIMIT));
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

/** Progreso temporal de un proceso running: transcurrido vs. duración total. */
function processProgress(
  p: TransformationProcess,
  nowMs: number,
): { value: number; max: number } {
  const start = Date.parse(p.started_at);
  const end = Date.parse(p.expected_end_at);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return { value: 0, max: 1 };
  }
  const max = end - start;
  const value = Math.min(Math.max(nowMs - start, 0), max);
  return { value, max };
}

/** Timestamp "ahora" que se refresca cada `intervalMs` (re-render periódico). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export default function TransformationsPage() {
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const authenticated = status === "authenticated";

  // ---- Filtro de estados (multi-chip; vacío = todos) ---------------------------
  const [selected, setSelected] = useState<ReadonlySet<ProcessStatus>>(
    new Set(),
  );
  const effectiveStatuses = useMemo(
    () => ALL_STATUSES.filter((s) => selected.has(s)),
    [selected],
  );

  const toggleStatus = (status: ProcessStatus) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  // ---- Datos ---------------------------------------------------------------------
  // Guard `enabled: authenticated`: no consultar endpoints autenticados hasta
  // que el bootstrap fije el access token; así evitamos un 401 que dispararía
  // un refresh en carrera con el del arranque (mismo refresh token rotatorio).
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
    enabled: authenticated,
  });
  const recipesQuery = useQuery({
    queryKey: ["catalog", "recipes"],
    queryFn: ({ signal }) =>
      api.get<Recipe[]>("/catalog/recipes", { signal, auth: false }),
    staleTime: Infinity,
  });
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const processesQuery = useInfiniteQuery({
    queryKey: ["processes", "list", effectiveStatuses],
    queryFn: ({ pageParam, signal }) =>
      api.get<TransformationPage>(
        `/transformations?${buildProcessesQuery(effectiveStatuses, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled: authenticated,
  });

  const self = selfQuery.data ?? null;
  const bankrupt = self !== null && self.agent.status === "bankrupt";
  const capacities = self?.capacities ?? [];

  const recipeById = useMemo(() => {
    const map = new Map<string, Recipe>();
    for (const r of recipesQuery.data ?? []) map.set(r.recipe_id, r);
    return map;
  }, [recipesQuery.data]);

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const recipeName = (recipeId: string): string =>
    recipeById.get(recipeId)?.name ?? truncId(recipeId);
  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;

  const rows = useMemo(
    () => processesQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [processesQuery.data],
  );

  const anyRunning = rows.some((p) => p.status === "running");
  const nowMs = useNow(anyRunning ? 1_000 : 30_000);

  // ---- Iniciar / cancelar procesos ---------------------------------------------------
  const [startOpen, setStartOpen] = useState(false);
  const [processToCancel, setProcessToCancel] =
    useState<TransformationProcess | null>(null);

  // ---- Detalle de proceso (trazabilidad FIFO) --------------------------------------
  const [processToView, setProcessToView] =
    useState<TransformationProcess | null>(null);
  const viewId = processToView?.process_id ?? null;

  const processDetailQuery = useQuery({
    queryKey: ["process", viewId],
    queryFn: ({ signal }) =>
      api.get<TransformationProcessDetail>(`/transformations/${viewId}`, {
        signal,
      }),
    enabled: viewId !== null,
  });
  const detail = processDetailQuery.data ?? null;
  const inputsConsumed = detail?.inputs_consumed ?? [];
  const producedLot = detail?.produced_lot ?? null;

  const inputColumns: Array<DataTableColumn<LotConsumption>> = [
    {
      key: "product",
      header: "Producto",
      render: (row) => (
        <span className={styles["cellProduct"]}>
          {productName(row.product_id)}
          <CopyId id={row.product_id} />
        </span>
      ),
    },
    {
      key: "lot_id",
      header: "Lote de origen",
      render: (row) => <CopyId id={row.lot_id} />,
    },
    {
      key: "qty_consumed_cent",
      header: "Cantidad",
      align: "right",
      mono: true,
      render: (row) => fmtQty(row.qty_consumed_cent, productUnit(row.product_id)),
    },
    {
      key: "unit_cost_cents",
      header: "Costo unitario",
      align: "right",
      mono: true,
      render: (row) => fmtMoney(row.unit_cost_cents),
    },
  ];

  const cancelProcess = useMutation({
    mutationFn: (processId: string) =>
      api.del<undefined>(`/transformations/${processId}`),
    onSuccess: () => {
      showToast({
        kind: "warning",
        title: "Proceso cancelado",
        body: "Sin reembolso: insumos y salario no se devuelven.",
      });
      setProcessToCancel(null);
      void queryClient.invalidateQueries({ queryKey: ["self"] });
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
    },
    onError: (err) => {
      // 409: ya estaba terminal → resincronizar el listado.
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["self"] });
        void queryClient.invalidateQueries({ queryKey: ["processes"] });
      }
    },
  });

  const openCancel = (process: TransformationProcess) => {
    cancelProcess.reset();
    setProcessToCancel(process);
  };

  // ---- Columnas -------------------------------------------------------------------------
  const columns: Array<DataTableColumn<TransformationProcess>> = [
    {
      key: "process_id",
      header: "Proceso",
      render: (row) => <CopyId id={row.process_id} />,
    },
    {
      key: "recipe",
      header: "Receta",
      sortValue: (row) => recipeName(row.recipe_id),
      render: (row) => recipeName(row.recipe_id),
    },
    {
      key: "execution",
      header: "Ejecución",
      align: "center",
      mono: true,
      render: (row) => `${row.current_execution}/${row.executions_planned}`,
    },
    {
      key: "status",
      header: "Estado",
      render: (row) => (
        <Badge kind={PROCESS_STATUS_BADGE[row.status]}>
          {PROCESS_STATUS_LABEL[row.status]}
        </Badge>
      ),
    },
    {
      key: "progress",
      header: "Progreso / fin",
      render: (row) => {
        if (row.status === "running") {
          const { value, max } = processProgress(row, nowMs);
          return (
            <div className={styles["progressCell"]}>
              <ProgressBar value={value} max={max} />
              <span
                className={styles["subtle"]}
                title={fmtDateTime(row.expected_end_at)}
              >
                Termina {fmtRelative(row.expected_end_at)}
              </span>
            </div>
          );
        }
        const endIso = row.actual_end_at ?? row.expected_end_at;
        return (
          <span className={styles["mono"]} title={fmtRelative(endIso)}>
            {fmtDateTime(endIso)}
          </span>
        );
      },
    },
    {
      key: "wage_paid_cents",
      header: "Salario pagado",
      align: "right",
      mono: true,
      render: (row) => fmtMoney(row.wage_paid_cents),
    },
    {
      key: "started_at",
      header: "Inicio",
      mono: true,
      sortValue: (row) => Date.parse(row.started_at),
      render: (row) => fmtDateTime(row.started_at),
    },
    {
      key: "actions",
      header: <span className="visually-hidden">Acciones</span>,
      align: "right",
      render: (row) => (
        <span className={styles["rowActions"]}>
          <button
            type="button"
            className={cx(styles["btn"], styles["btnGhost"])}
            onClick={() => setProcessToView(row)}
            aria-label={`Ver detalle del proceso ${truncId(row.process_id)}`}
          >
            Detalle
          </button>
          {row.status === "running" && (
            <button
              type="button"
              className={cx(styles["btn"], styles["btnDangerGhost"])}
              onClick={() => openCancel(row)}
              disabled={bankrupt}
              aria-label={`Cancelar proceso ${truncId(row.process_id)}`}
            >
              Cancelar
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Transformaciones</h1>
        <button
          type="button"
          className={cx(styles["btn"], styles["btnPrimary"])}
          onClick={() => setStartOpen(true)}
          disabled={bankrupt || (self !== null && capacities.length === 0)}
        >
          Iniciar proceso
        </button>
      </div>

      {bankrupt && (
        <ErrorBanner
          problem={{
            title: "Agente en quiebra",
            detail:
              "Este agente salió del mercado: las operaciones de escritura están deshabilitadas.",
          }}
        />
      )}

      {/* Capacidades instaladas */}
      <section className={styles["panel"]} aria-labelledby="tf-capacities">
        <div className={styles["panelHead"]}>
          <h2 id="tf-capacities" className={styles["panelTitle"]}>
            Capacidades instaladas
          </h2>
          <p className={styles["panelHint"]}>
            Procesos en curso frente a instalaciones por receta
          </p>
        </div>
        {selfQuery.isPending ? (
          <Skeleton rows={2} />
        ) : selfQuery.isError ? (
          <ErrorBanner problem={toProblem(selfQuery.error)} />
        ) : capacities.length === 0 ? (
          <EmptyState
            title="Sin capacidades instaladas"
            hint="Este agente no puede ejecutar recetas de transformación; las capacidades se asignan al registrarse."
          />
        ) : (
          <div className={styles["capacityGrid"]}>
            {capacities.map((c) => {
              const recipe = recipeById.get(c.recipe_id);
              const slots = availableSlots(c);
              return (
                <div key={c.recipe_id} className={styles["capacityCard"]}>
                  <div className={styles["capacityHead"]}>
                    <span className={styles["capacityName"]}>
                      {recipe?.name ?? truncId(c.recipe_id)}
                    </span>
                    <CopyId id={c.recipe_id} />
                  </div>
                  <ProgressBar
                    value={c.running}
                    max={c.installations}
                    label={`${c.running}/${c.installations} en uso`}
                  />
                  <p className={styles["capacityMeta"]}>
                    {slots === 0 ? (
                      <Badge kind="partial">Saturada</Badge>
                    ) : (
                      <Badge kind="active">
                        {slots} {slots === 1 ? "hueco libre" : "huecos libres"}
                      </Badge>
                    )}
                  </p>
                  {recipe !== undefined && (
                    <p className={styles["capacityMeta"]}>
                      Produce {productName(recipe.output_product_id)} ·{" "}
                      {fmtDurationSeconds(recipe.duration_seconds)}{" "}
                      <span className={styles["subtle"]}>
                        {realDurationSimHint(recipe.duration_seconds)}
                      </span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Filtros de estado */}
      <div
        className={styles["filters"]}
        role="group"
        aria-label="Filtrar procesos por estado"
      >
        <button
          type="button"
          className={cx(
            styles["chip"],
            selected.size === 0 ? styles["chipActive"] : undefined,
          )}
          aria-pressed={selected.size === 0}
          onClick={() => setSelected(new Set())}
        >
          Todos
        </button>
        {ALL_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={cx(
              styles["chip"],
              selected.has(status) ? styles["chipActive"] : undefined,
            )}
            aria-pressed={selected.has(status)}
            onClick={() => toggleStatus(status)}
          >
            {STATUS_PLURAL[status]}
          </button>
        ))}
      </div>

      {/* Procesos */}
      {processesQuery.isError ? (
        <>
          <ErrorBanner problem={toProblem(processesQuery.error)} />
          <div>
            <button
              type="button"
              className={cx(styles["btn"], styles["btnPrimary"])}
              onClick={() => void processesQuery.refetch()}
            >
              Reintentar
            </button>
          </div>
        </>
      ) : (
        <section className={styles["panel"]} aria-labelledby="tf-processes">
          <div className={styles["panelHead"]}>
            <h2 id="tf-processes" className={styles["panelTitle"]}>
              Procesos
            </h2>
            <p className={styles["panelHint"]}>
              {rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? "proceso cargado" : "procesos cargados"}`
                : "Procesos de transformación del agente"}
            </p>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            loading={processesQuery.isPending}
            rowKey={(row) => row.process_id}
            caption="Procesos de transformación con estado, progreso, salario pagado e inicio"
            empty={
              <EmptyState
                title="Sin procesos con este filtro"
                hint="Inicia una transformación con el botón «Iniciar proceso»."
              />
            }
          />
          <div className={styles["loadMoreRow"]}>
            {processesQuery.hasNextPage ? (
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => void processesQuery.fetchNextPage()}
                disabled={processesQuery.isFetchingNextPage}
              >
                {processesQuery.isFetchingNextPage
                  ? "Cargando…"
                  : "Cargar más"}
              </button>
            ) : (
              rows.length > 0 && (
                <p className={styles["subtle"]}>No hay más procesos.</p>
              )
            )}
          </div>
        </section>
      )}

      {/* Modal: iniciar proceso */}
      <StartProcessModal open={startOpen} onClose={() => setStartOpen(false)} />

      {/* Modal: cancelar proceso (SIN reembolso) */}
      <Modal
        open={processToCancel !== null}
        onClose={() => {
          if (!cancelProcess.isPending) setProcessToCancel(null);
        }}
        title="Cancelar proceso"
      >
        {processToCancel !== null && (
          <div className={styles["modalBody"]}>
            <p>
              ¿Seguro que quieres cancelar el proceso{" "}
              <code className={styles["mono"]}>
                {truncId(processToCancel.process_id)}
              </code>{" "}
              ({recipeName(processToCancel.recipe_id)})?
            </p>
            <div className={styles["warnBox"]} role="alert">
              <strong>Sin reembolso.</strong> Los insumos ya consumidos y el
              salario pagado (
              <span className={styles["mono"]}>
                {fmtMoney(processToCancel.wage_paid_cents)}
              </span>
              ) <strong>no se devuelven</strong>. No se producirá ningún lote.
            </div>
            {cancelProcess.isError && (
              <ErrorBanner problem={toProblem(cancelProcess.error)} />
            )}
            <div className={styles["modalActions"]}>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => setProcessToCancel(null)}
                disabled={cancelProcess.isPending}
              >
                Seguir produciendo
              </button>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnDanger"])}
                onClick={() =>
                  cancelProcess.mutate(processToCancel.process_id)
                }
                disabled={cancelProcess.isPending || bankrupt}
              >
                {cancelProcess.isPending
                  ? "Cancelando…"
                  : "Cancelar sin reembolso"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Modal: detalle de proceso (trazabilidad FIFO) */}
      <Modal
        open={processToView !== null}
        onClose={() => setProcessToView(null)}
        title="Detalle del proceso"
      >
        {processToView !== null && (
          <div className={styles["modalBody"]}>
            <dl className={styles["detailList"]}>
              <dt>Proceso</dt>
              <dd>
                <CopyId id={processToView.process_id} />
              </dd>
              <dt>Receta</dt>
              <dd>{recipeName(processToView.recipe_id)}</dd>
              <dt>Estado</dt>
              <dd>
                <Badge kind={PROCESS_STATUS_BADGE[processToView.status]}>
                  {PROCESS_STATUS_LABEL[processToView.status]}
                </Badge>
              </dd>
              <dt>Ejecución</dt>
              <dd className={styles["mono"]}>
                {processToView.current_execution}/
                {processToView.executions_planned}
              </dd>
              <dt>Salario pagado</dt>
              <dd className={styles["mono"]}>
                {fmtMoney(processToView.wage_paid_cents)}
              </dd>
            </dl>

            {processDetailQuery.isError ? (
              <>
                <ErrorBanner problem={toProblem(processDetailQuery.error)} />
                <div>
                  <button
                    type="button"
                    className={cx(styles["btn"], styles["btnSecondary"])}
                    onClick={() => void processDetailQuery.refetch()}
                  >
                    Reintentar
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* Insumos consumidos (FIFO) */}
                <section className={styles["detailSection"]}>
                  <h3 className={styles["detailLabel"]}>
                    Insumos consumidos (FIFO)
                  </h3>
                  <DataTable
                    columns={inputColumns}
                    rows={inputsConsumed}
                    loading={processDetailQuery.isPending}
                    rowKey={(row) => row.lot_id}
                    caption="Lotes de insumos consumidos por el proceso, con cantidad y costo unitario al momento del consumo"
                    empty={
                      <EmptyState
                        title="Sin insumos registrados"
                        hint="Este proceso no consumió lotes de insumos o el detalle aún no está disponible."
                      />
                    }
                  />
                </section>

                {/* Lote producido */}
                <section className={styles["detailSection"]}>
                  <h3 className={styles["detailLabel"]}>Lote producido</h3>
                  {processDetailQuery.isPending ? (
                    <Skeleton rows={2} />
                  ) : producedLot !== null ? (
                    <dl className={styles["detailList"]}>
                      <dt>Lote</dt>
                      <dd>
                        <CopyId id={producedLot.lot_id} />
                      </dd>
                      <dt>Producto</dt>
                      <dd>{productName(producedLot.product_id)}</dd>
                      <dt>Cantidad producida</dt>
                      <dd className={styles["mono"]}>
                        {fmtQty(
                          producedLot.qty_original_cent,
                          productUnit(producedLot.product_id),
                        )}
                      </dd>
                      <dt>Costo unitario</dt>
                      <dd className={styles["mono"]}>
                        {fmtMoney(producedLot.unit_cost_cents)}
                      </dd>
                    </dl>
                  ) : (
                    <EmptyState
                      title="Aún sin lote producido"
                      hint="El lote se materializa cuando el proceso completa; mientras está en curso no hay producción."
                    />
                  )}
                </section>
              </>
            )}

            <div className={styles["modalActions"]}>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => setProcessToView(null)}
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
