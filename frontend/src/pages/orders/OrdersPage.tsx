/**
 * OrdersPage [FE7] — listado y gestión de órdenes propias (design doc §4.2,
 * contrato §orders).
 *
 * Datos:
 * - ["orders", "list", statuses] → GET /orders (paginación por cursor del
 *   openapi vía useInfiniteQuery + botón "Cargar más"; `status` repetible).
 *   El API por defecto devuelve solo activas/parciales, así que el filtro
 *   "Todas" envía los 5 estados explícitamente.
 * - ["catalog", "products"] → nombres/unidades de productos.
 * - ["self"] → estado bankrupt (deshabilita escritura) y datos del form.
 *
 * Acciones:
 * - Nueva orden → OrderFormModal (POST /orders).
 * - Cancelar (solo activas/parciales) → Modal de confirmación
 *   → DELETE /orders/{id} → invalidate ["orders"] + ["self"].
 */
import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  Order,
  OrderPage,
  OrderStatus,
  Problem,
  Product,
  SelfState,
} from "../../api/types";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  Modal,
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
import { ORDER_SIDE_LABEL, ORDER_STATUS_LABEL } from "./orderLabels";
import { OrderFormModal } from "./OrderFormModal";
import styles from "./OrdersPage.module.css";

const PAGE_LIMIT = 50;

/** Orden canónico de estados (para chips y queryKey estable). */
const ALL_STATUSES: readonly OrderStatus[] = [
  "active",
  "partial",
  "completed",
  "cancelled",
  "expired",
];

/** Etiquetas en plural para los chips de filtro. */
const STATUS_PLURAL: Record<OrderStatus, string> = {
  active: "Activas",
  partial: "Parciales",
  completed: "Completadas",
  cancelled: "Canceladas",
  expired: "Expiradas",
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

/** Query string de GET /orders (status repetible + cursor). */
function buildOrdersQuery(
  statuses: readonly OrderStatus[],
  cursor: string | null,
): string {
  const params = new URLSearchParams();
  for (const s of statuses) params.append("status", s);
  params.set("limit", String(PAGE_LIMIT));
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export default function OrdersPage() {
  const queryClient = useQueryClient();

  // ---- Filtro de estados (multi-chip; vacío = todas) -------------------------
  const [selected, setSelected] = useState<ReadonlySet<OrderStatus>>(
    new Set(),
  );
  const effectiveStatuses = useMemo(
    () =>
      selected.size === 0
        ? ALL_STATUSES
        : ALL_STATUSES.filter((s) => selected.has(s)),
    [selected],
  );

  const toggleStatus = (status: OrderStatus) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  // ---- Datos -------------------------------------------------------------------
  const ordersQuery = useInfiniteQuery({
    queryKey: ["orders", "list", effectiveStatuses],
    queryFn: ({ pageParam, signal }) =>
      api.get<OrderPage>(
        `/orders?${buildOrdersQuery(effectiveStatuses, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
  });

  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
  });

  const bankrupt = selfQuery.data?.agent.status === "bankrupt";

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;

  const rows = useMemo(
    () => ordersQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [ordersQuery.data],
  );

  // ---- Crear orden ----------------------------------------------------------------
  const [formOpen, setFormOpen] = useState(false);

  // ---- Cancelar orden ---------------------------------------------------------------
  const [orderToCancel, setOrderToCancel] = useState<Order | null>(null);

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
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["self"] });
    },
  });

  const openCancel = (order: Order) => {
    cancelOrder.reset();
    setOrderToCancel(order);
  };

  // ---- Columnas -----------------------------------------------------------------------
  const columns: Array<DataTableColumn<Order>> = [
    {
      key: "order_id",
      header: "Orden",
      render: (row) => <CopyId id={row.order_id} />,
    },
    {
      key: "side",
      header: "Lado",
      render: (row) => (
        <Badge kind={row.side}>{ORDER_SIDE_LABEL[row.side]}</Badge>
      ),
    },
    {
      key: "product",
      header: "Producto",
      sortValue: (row) => productName(row.product_id),
      render: (row) => (
        <span className={styles["cellProduct"]}>
          {productName(row.product_id)}
        </span>
      ),
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
      key: "created_at",
      header: "Creada",
      mono: true,
      sortValue: (row) => Date.parse(row.created_at),
      render: (row) => fmtDateTime(row.created_at),
    },
    {
      key: "expires_at",
      header: "Expira",
      mono: true,
      sortValue: (row) => Date.parse(row.expires_at),
      render: (row) =>
        row.status === "active" || row.status === "partial" ? (
          <span title={fmtDateTime(row.expires_at)}>
            {fmtRelative(row.expires_at)}
          </span>
        ) : (
          <span className={styles["subtle"]}>—</span>
        ),
    },
    {
      key: "actions",
      header: <span className="visually-hidden">Acciones</span>,
      align: "right",
      render: (row) =>
        row.status === "active" || row.status === "partial" ? (
          <button
            type="button"
            className={cx(styles["btn"], styles["btnDangerGhost"])}
            onClick={() => openCancel(row)}
            disabled={bankrupt}
            aria-label={`Cancelar orden ${truncId(row.order_id)}`}
          >
            Cancelar
          </button>
        ) : null,
    },
  ];

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Órdenes</h1>
        <button
          type="button"
          className={cx(styles["btn"], styles["btnPrimary"])}
          onClick={() => setFormOpen(true)}
          disabled={bankrupt}
        >
          Nueva orden
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

      {/* Filtros de estado */}
      <div
        className={styles["filters"]}
        role="group"
        aria-label="Filtrar órdenes por estado"
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
          Todas
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

      {ordersQuery.isError ? (
        <>
          <ErrorBanner problem={toProblem(ordersQuery.error)} />
          <div>
            <button
              type="button"
              className={cx(styles["btn"], styles["btnPrimary"])}
              onClick={() => void ordersQuery.refetch()}
            >
              Reintentar
            </button>
          </div>
        </>
      ) : (
        <section className={styles["panel"]} aria-labelledby="orders-list">
          <div className={styles["panelHead"]}>
            <h2 id="orders-list" className={styles["panelTitle"]}>
              Mis órdenes
            </h2>
            <p className={styles["panelHint"]}>
              {rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? "orden cargada" : "órdenes cargadas"}`
                : "Órdenes del agente autenticado"}
            </p>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            loading={ordersQuery.isPending}
            sortable
            rowKey={(row) => row.order_id}
            caption="Órdenes del agente con lado, producto, cantidades, precio límite, estado y expiración"
            empty={
              <EmptyState
                title="Sin órdenes con este filtro"
                hint="Coloca una orden con el botón «Nueva orden»."
              />
            }
          />
          <div className={styles["loadMoreRow"]}>
            {ordersQuery.hasNextPage ? (
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => void ordersQuery.fetchNextPage()}
                disabled={ordersQuery.isFetchingNextPage}
              >
                {ordersQuery.isFetchingNextPage ? "Cargando…" : "Cargar más"}
              </button>
            ) : (
              rows.length > 0 && (
                <p className={styles["subtle"]}>No hay más órdenes.</p>
              )
            )}
          </div>
        </section>
      )}

      {/* Modal: nueva orden */}
      <OrderFormModal open={formOpen} onClose={() => setFormOpen(false)} />

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
                  {ORDER_SIDE_LABEL[orderToCancel.side]}
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
    </div>
  );
}
