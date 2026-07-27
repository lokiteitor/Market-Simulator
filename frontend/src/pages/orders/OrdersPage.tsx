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
 * - Cancelar (activas/parciales) o liberar reservas (ya vencidas pero aún sin
 *   barrer) → CancelOrderModal → DELETE /orders/{id}
 *   → invalidate ["orders"] + ["self"].
 *
 * El estado que se pinta es el DE PRESENTACIÓN (orderDisplayStatus): una orden
 * cuyo `expires_at` ya pasó se marca «Vencida» aunque el servidor todavía la
 * devuelva como activa, porque el barrido de expiración corre cada ~5 s.
 */
import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import { toProblem } from "../../api/problem";
import type {
  Order,
  OrderPage,
  OrderStatus,
  Problem,
  Product,
  SelfState,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
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
import { useNow } from "../../lib/processTime";
import { CancelOrderModal } from "./CancelOrderModal";
import {
  EXPIRING_HINT,
  isCancellable,
  ORDER_DISPLAY_STATUS_LABEL,
  orderDisplayStatus,
} from "./orderDisplayStatus";
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
  const { status } = useAuth();
  const authenticated = status === "authenticated";

  // Tick de 1s: el estado "Vencida" y el "expira dentro de…" se derivan del
  // reloj del cliente, no del servidor.
  const nowMs = useNow(1_000);

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
  // Guard `enabled: authenticated`: no consultar endpoints autenticados hasta
  // que el bootstrap fije el access token; así evitamos un 401 que dispararía
  // un refresh en carrera con el del arranque (mismo refresh token rotatorio).
  const ordersQuery = useInfiniteQuery({
    queryKey: ["orders", "list", effectiveStatuses],
    queryFn: ({ pageParam, signal }) =>
      api.get<OrderPage>(
        `/orders?${buildOrdersQuery(effectiveStatuses, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    enabled: authenticated,
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
    enabled: authenticated,
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
      render: (row) => {
        const text = `${fmtQty(row.qty_pending_cent)} / ${fmtQty(
          row.qty_original_cent,
          productUnit(row.product_id),
        )}`;
        // En las terminales no completadas, lo pendiente ya volvió al agente.
        const released =
          row.status === "cancelled" || row.status === "expired";
        return released ? (
          <span title="Cantidad no ejecutada: sus reservas ya se devolvieron a tu capital o a tus lotes">
            {text}
          </span>
        ) : (
          text
        );
      },
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
      sortValue: (row) => ORDER_DISPLAY_STATUS_LABEL[orderDisplayStatus(row, nowMs)],
      render: (row) => {
        // El barrido de expiración corre cada ~5 s: hasta que pasa, una orden
        // ya vencida sigue llegando como `active`/`partial`. Se marca aparte
        // para no hacerla pasar por activa.
        const display = orderDisplayStatus(row, nowMs);
        return display === "expiring" ? (
          <Badge kind="expired">
            <span title={EXPIRING_HINT}>
              {ORDER_DISPLAY_STATUS_LABEL.expiring}
            </span>
          </Badge>
        ) : (
          <Badge kind={display}>{ORDER_DISPLAY_STATUS_LABEL[display]}</Badge>
        );
      },
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
      render: (row) => {
        const display = orderDisplayStatus(row, nowMs);
        // Las completadas/canceladas ya no vencen: su expires_at no dice nada.
        if (display === "completed" || display === "cancelled") {
          return <span className={styles["subtle"]}>—</span>;
        }
        // Las expiradas sí: interesa CUÁNDO vencieron.
        if (display === "expired") {
          return (
            <span className={styles["subtle"]} title={fmtDateTime(row.expires_at)}>
              {fmtRelative(row.expires_at)}
            </span>
          );
        }
        return (
          <span title={fmtDateTime(row.expires_at)}>
            {fmtRelative(row.expires_at)}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: <span className="visually-hidden">Acciones</span>,
      align: "right",
      render: (row) => {
        const display = orderDisplayStatus(row, nowMs);
        if (!isCancellable(display)) return null;
        const releasing = display === "expiring";
        return (
          <button
            type="button"
            className={cx(styles["btn"], styles["btnDangerGhost"])}
            onClick={() => openCancel(row)}
            disabled={bankrupt}
            aria-label={`${releasing ? "Liberar las reservas de la orden" : "Cancelar orden"} ${truncId(row.order_id)}`}
          >
            {releasing ? "Liberar reservas" : "Cancelar"}
          </button>
        );
      },
    },
  ];

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <div>
          <h1 className={styles["title"]}>Órdenes</h1>
          <p className={styles["lede"]}>
            Al cancelar o expirar una orden, sus reservas —capital en las
            compras, mercancía en las ventas— vuelven íntegras a tu cuenta.
          </p>
        </div>
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

      {/* Modal: cancelar orden (o liberar reservas si ya venció) */}
      <CancelOrderModal
        order={orderToCancel}
        nowMs={nowMs}
        productName={productName}
        productUnit={productUnit}
        onClose={() => setOrderToCancel(null)}
        onConfirm={(orderId) => cancelOrder.mutate(orderId)}
        pending={cancelOrder.isPending}
        error={cancelOrder.isError ? toProblem(cancelOrder.error) : null}
        disabled={bankrupt}
      />
    </div>
  );
}
