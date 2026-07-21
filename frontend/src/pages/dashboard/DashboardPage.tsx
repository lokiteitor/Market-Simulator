/**
 * DashboardPage [FE5] — pantalla principal del agente (design doc §4.1).
 *
 * Datos:
 * - ["self"]              → GET /agents/me (AgentSnapshot: capital, inventario,
 *                           órdenes activas, procesos running, capacidades).
 * - ["self", "lots"]      → GET /agents/me/inventory/lots (valor estimado de
 *                           inventario = Σ qty × unit_cost / 100).
 * - ["catalog", ...]      → GET /catalog/products | /catalog/recipes (nombres
 *                           y unidades; catálogo estático durante la corrida).
 *
 * Acciones:
 * - Cancelar orden   → Modal de confirmación → DELETE /orders/{id}
 *                      → invalidate ["self"] + ["orders"].
 * - Cancelar proceso → Modal con advertencia SIN reembolso
 *                      → DELETE /transformations/{id}
 *                      → invalidate ["self"] + ["processes"].
 *
 * El progreso de procesos running se re-renderiza periódicamente (tick 1s
 * mientras haya procesos) contra `expected_end_at`.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  AgentRole,
  InventoryLot,
  InventoryPosition,
  Order,
  OrderSide,
  OrderStatus,
  Problem,
  Product,
  Recipe,
  SelfState,
  TransformationProcess,
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
  StatCard,
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
import styles from "./DashboardPage.module.css";

// ---------------------------------------------------------------------------
// Etiquetas de dominio (es)
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<AgentRole, string> = {
  transformer: "Transformador",
  consumer: "Consumidor",
  trader: "Trader",
  admin: "Administrador",
  bank: "Banco central",
};

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  active: "Activa",
  partial: "Parcial",
  completed: "Completada",
  cancelled: "Cancelada",
  expired: "Expirada",
};

const SIDE_LABEL: Record<OrderSide, string> = {
  buy: "Compra",
  sell: "Venta",
};

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

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

/**
 * Valor estimado del inventario en centavos:
 * Σ (qty_available + qty_reserved) × unit_cost_cents / 100 sobre los lotes.
 * (qty en centésimas × costo en centavos → /100 para volver a centavos.)
 */
function estimateInventoryValueCents(lots: readonly InventoryLot[]): number {
  let total = 0;
  for (const lot of lots) {
    total +=
      ((lot.qty_available_cent + lot.qty_reserved_cent) *
        lot.unit_cost_cents) /
      100;
  }
  return Math.round(total);
}

/** Progreso temporal de un proceso: transcurrido vs. duración total. */
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

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const authenticated = status === "authenticated";

  // ---- Datos ---------------------------------------------------------------
  // Guard `enabled`: no consultar endpoints autenticados hasta que el bootstrap
  // fije el access token; así evitamos un 401 que dispararía un refresh en
  // carrera con el del arranque (mismo refresh token rotatorio).
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
    enabled: authenticated,
  });

  const lotsQuery = useQuery({
    queryKey: ["self", "lots"],
    queryFn: ({ signal }) =>
      api.get<InventoryLot[]>("/agents/me/inventory/lots", { signal }),
    enabled: authenticated,
  });

  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const recipesQuery = useQuery({
    queryKey: ["catalog", "recipes"],
    queryFn: ({ signal }) =>
      api.get<Recipe[]>("/catalog/recipes", { signal, auth: false }),
    staleTime: Infinity,
  });

  const self = selfQuery.data ?? null;
  const bankrupt = self !== null && self.agent.status === "bankrupt";
  const runningProcesses = self?.running_processes ?? [];

  // Tick: 1s mientras haya procesos running (ProgressBar); 30s si no
  // (mantiene frescos los "expira dentro de…" de las órdenes).
  const nowMs = useNow(runningProcesses.length > 0 ? 1_000 : 30_000);

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const recipeById = useMemo(() => {
    const map = new Map<string, Recipe>();
    for (const r of recipesQuery.data ?? []) map.set(r.recipe_id, r);
    return map;
  }, [recipesQuery.data]);

  const inventoryValueCents = useMemo(
    () =>
      lotsQuery.data !== undefined
        ? estimateInventoryValueCents(lotsQuery.data)
        : null,
    [lotsQuery.data],
  );

  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;
  const recipeName = (recipeId: string): string =>
    recipeById.get(recipeId)?.name ?? truncId(recipeId);

  // ---- Mutaciones (cancelaciones) -------------------------------------------
  const [orderToCancel, setOrderToCancel] = useState<Order | null>(null);
  const [processToCancel, setProcessToCancel] =
    useState<TransformationProcess | null>(null);

  const cancelOrder = useMutation({
    // 204 → undefined; 200 → la orden ya estaba en estado terminal.
    mutationFn: (orderId: string) =>
      api.del<Order | undefined>(`/orders/${orderId}`),
    onSuccess: (data) => {
      if (data !== undefined && data.status !== "cancelled") {
        showToast({
          kind: "info",
          title: `La orden ya estaba ${ORDER_STATUS_LABEL[data.status].toLowerCase()}`,
        });
      } else {
        showToast({
          kind: "success",
          title: "Orden cancelada",
          body: "Se liberaron las reservas residuales.",
        });
      }
      setOrderToCancel(null);
      void queryClient.invalidateQueries({ queryKey: ["self"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });

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
      // 409: ya estaba terminal → resincronizar para sacarlo de la tabla.
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["self"] });
        void queryClient.invalidateQueries({ queryKey: ["processes"] });
      }
    },
  });

  const openCancelOrder = (order: Order) => {
    cancelOrder.reset();
    setOrderToCancel(order);
  };
  const openCancelProcess = (process: TransformationProcess) => {
    cancelProcess.reset();
    setProcessToCancel(process);
  };

  // ---- Columnas --------------------------------------------------------------
  const inventoryColumns: Array<DataTableColumn<InventoryPosition>> = [
    {
      key: "product",
      header: "Producto",
      sortValue: (row) => productName(row.product_id),
      render: (row) => (
        <span className={styles["cellProduct"]}>
          {productName(row.product_id)}
          <CopyId id={row.product_id} />
        </span>
      ),
    },
    {
      key: "qty_available_cent",
      header: "Disponible",
      align: "right",
      mono: true,
      render: (row) => fmtQty(row.qty_available_cent, productUnit(row.product_id)),
    },
    {
      key: "qty_reserved_cent",
      header: "Reservada",
      align: "right",
      mono: true,
      render: (row) => fmtQty(row.qty_reserved_cent, productUnit(row.product_id)),
    },
  ];

  const orderColumns: Array<DataTableColumn<Order>> = [
    {
      key: "order_id",
      header: "Orden",
      render: (row) => <CopyId id={row.order_id} />,
    },
    {
      key: "side",
      header: "Lado",
      render: (row) => <Badge kind={row.side}>{SIDE_LABEL[row.side]}</Badge>,
    },
    {
      key: "product",
      header: "Producto",
      sortValue: (row) => productName(row.product_id),
      render: (row) => productName(row.product_id),
    },
    {
      key: "qty",
      header: "Pendiente / original",
      align: "right",
      mono: true,
      sortValue: (row) => row.qty_pending_cent,
      render: (row) =>
        `${fmtQty(row.qty_pending_cent)} / ${fmtQty(
          row.qty_original_cent,
          productUnit(row.product_id),
        )}`,
    },
    {
      key: "limit_price_cents",
      header: "Límite",
      align: "right",
      mono: true,
      render: (row) => fmtMoney(row.limit_price_cents),
    },
    {
      key: "status",
      header: "Estado",
      render: (row) => (
        <Badge kind={row.status}>{ORDER_STATUS_LABEL[row.status]}</Badge>
      ),
    },
    {
      key: "expires_at",
      header: "Expira",
      mono: true,
      sortValue: (row) => Date.parse(row.expires_at),
      render: (row) => (
        <span title={fmtDateTime(row.expires_at)}>
          {fmtRelative(row.expires_at)}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="visually-hidden">Acciones</span>,
      align: "right",
      render: (row) => (
        <button
          type="button"
          className={cx(styles["btn"], styles["btnDangerGhost"])}
          onClick={() => openCancelOrder(row)}
          disabled={bankrupt}
          aria-label={`Cancelar orden ${truncId(row.order_id)}`}
        >
          Cancelar
        </button>
      ),
    },
  ];

  const processColumns: Array<DataTableColumn<TransformationProcess>> = [
    {
      key: "process_id",
      header: "Proceso",
      render: (row) => <CopyId id={row.process_id} />,
    },
    {
      key: "recipe",
      header: "Receta",
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
      key: "progress",
      header: "Progreso",
      render: (row) => {
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
      key: "actions",
      header: <span className="visually-hidden">Acciones</span>,
      align: "right",
      render: (row) => (
        <button
          type="button"
          className={cx(styles["btn"], styles["btnDangerGhost"])}
          onClick={() => openCancelProcess(row)}
          disabled={bankrupt}
          aria-label={`Cancelar proceso ${truncId(row.process_id)}`}
        >
          Cancelar
        </button>
      ),
    },
  ];

  // ---- Estados de página -----------------------------------------------------
  if (selfQuery.isError) {
    return (
      <div className={styles["page"]}>
        <h1 className={styles["title"]}>Dashboard</h1>
        <ErrorBanner problem={toProblem(selfQuery.error)} />
        <div>
          <button
            type="button"
            className={cx(styles["btn"], styles["btnPrimary"])}
            onClick={() => void selfQuery.refetch()}
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  const loading = selfQuery.isPending;

  return (
    <div className={styles["page"]}>
      {/* Cabecera: identidad del agente */}
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Dashboard</h1>
        {self !== null && (
          <div className={styles["who"]}>
            <span className={styles["whoName"]}>{self.agent.username}</span>
            <Badge kind={self.agent.role}>{ROLE_LABEL[self.agent.role]}</Badge>
            <Badge kind={self.agent.status}>
              {self.agent.status === "bankrupt" ? "En quiebra" : "Activo"}
            </Badge>
          </div>
        )}
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

      {/* KPIs */}
      {loading ? (
        <div className={styles["panel"]}>
          <Skeleton rows={3} />
        </div>
      ) : (
        self !== null && (
          <div className={styles["statsGrid"]}>
            <StatCard
              label="Capital disponible"
              value={fmtMoney(self.capital_available_cents)}
            />
            <StatCard
              label="Capital reservado"
              value={fmtMoney(self.capital_reserved_cents)}
              hint="Comprometido en órdenes de compra"
            />
            <StatCard
              label="Órdenes activas"
              value={self.active_orders.length}
              hint="Activas o parciales"
            />
            <StatCard
              label="Procesos en curso"
              value={self.running_processes.length}
              hint="Transformaciones running"
            />
            <StatCard
              label="Valor estimado de inventario"
              value={
                lotsQuery.isPending
                  ? "…"
                  : inventoryValueCents !== null
                    ? fmtMoney(inventoryValueCents)
                    : "—"
              }
              hint="Σ cantidad × costo unitario (lotes)"
            />
          </div>
        )
      )}

      {/* Inventario */}
      <section className={styles["panel"]} aria-labelledby="dash-inventory">
        <div className={styles["panelHead"]}>
          <h2 id="dash-inventory" className={styles["panelTitle"]}>
            Inventario
          </h2>
          <p className={styles["panelHint"]}>Posiciones agregadas por producto</p>
        </div>
        <DataTable
          columns={inventoryColumns}
          rows={self?.inventory ?? []}
          loading={loading}
          sortable
          rowKey={(row) => row.product_id}
          caption="Inventario del agente: cantidades disponibles y reservadas por producto"
          empty={
            <EmptyState
              title="Sin inventario"
              hint="Compra en el mercado o inicia una producción para obtener existencias."
            />
          }
        />
      </section>

      {/* Órdenes activas */}
      <section className={styles["panel"]} aria-labelledby="dash-orders">
        <div className={styles["panelHead"]}>
          <h2 id="dash-orders" className={styles["panelTitle"]}>
            Órdenes activas
          </h2>
          <p className={styles["panelHint"]}>
            Órdenes en estado activa o parcial
          </p>
        </div>
        <DataTable
          columns={orderColumns}
          rows={self?.active_orders ?? []}
          loading={loading}
          sortable
          rowKey={(row) => row.order_id}
          caption="Órdenes activas del agente con cantidad pendiente, precio límite y expiración"
          empty={
            <EmptyState
              title="Sin órdenes activas"
              hint="Coloca una orden desde Mercado u Órdenes."
            />
          }
        />
      </section>

      {/* Procesos en curso */}
      <section className={styles["panel"]} aria-labelledby="dash-processes">
        <div className={styles["panelHead"]}>
          <h2 id="dash-processes" className={styles["panelTitle"]}>
            Procesos en curso
          </h2>
          <p className={styles["panelHint"]}>
            Transformaciones running y su avance estimado
          </p>
        </div>
        <DataTable
          columns={processColumns}
          rows={runningProcesses}
          loading={loading}
          rowKey={(row) => row.process_id}
          caption="Procesos de transformación en curso con progreso hasta su fin esperado"
          empty={
            <EmptyState
              title="Sin procesos en curso"
              hint="Inicia una transformación desde la página Transformaciones."
            />
          }
        />
      </section>

      {/* Modal: cancelar orden */}
      <Modal
        open={orderToCancel !== null}
        onClose={() => {
          if (!cancelOrder.isPending) setOrderToCancel(null);
        }}
        title="Cancelar orden"
      >
        {orderToCancel !== null && (
          <div className={styles["modalBody"]}>
            <p>
              ¿Seguro que quieres cancelar la orden{" "}
              <code className={styles["mono"]}>
                {truncId(orderToCancel.order_id)}
              </code>
              ?
            </p>
            <dl className={styles["detailList"]}>
              <dt>Producto</dt>
              <dd>{productName(orderToCancel.product_id)}</dd>
              <dt>Lado</dt>
              <dd>
                <Badge kind={orderToCancel.side}>
                  {SIDE_LABEL[orderToCancel.side]}
                </Badge>
              </dd>
              <dt>Pendiente</dt>
              <dd className={styles["mono"]}>
                {fmtQty(
                  orderToCancel.qty_pending_cent,
                  productUnit(orderToCancel.product_id),
                )}
              </dd>
              <dt>Precio límite</dt>
              <dd className={styles["mono"]}>
                {fmtMoney(orderToCancel.limit_price_cents)}
              </dd>
            </dl>
            <p className={styles["subtle"]}>
              Se liberarán las reservas residuales (capital o inventario). La
              cancelación es gratuita.
            </p>
            {cancelOrder.isError && (
              <ErrorBanner problem={toProblem(cancelOrder.error)} />
            )}
            <div className={styles["modalActions"]}>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => setOrderToCancel(null)}
                disabled={cancelOrder.isPending}
              >
                Mantener orden
              </button>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnDanger"])}
                onClick={() => cancelOrder.mutate(orderToCancel.order_id)}
                disabled={cancelOrder.isPending || bankrupt}
              >
                {cancelOrder.isPending ? "Cancelando…" : "Cancelar orden"}
              </button>
            </div>
          </div>
        )}
      </Modal>

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
                onClick={() => cancelProcess.mutate(processToCancel.process_id)}
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
    </div>
  );
}
