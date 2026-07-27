/**
 * InventoryPage [FE-INV] — inventario del agente con detalle de lotes FIFO.
 *
 * El dashboard solo muestra un resumen (disponible / reservado por producto);
 * aquí se ve de dónde salió cada unidad y a qué coste, que es lo que permite
 * decidir a qué precio vender sin producir a pérdida.
 *
 * Datos:
 * - ["self", "lots"] → GET /agents/me/inventory/lots (misma queryKey que el
 *   dashboard: comparten caché y las invalidaciones por prefijo ["self"] del
 *   NotificationsProvider las refrescan a la vez).
 * - ["catalog", "products"] → nombre, unidad y categoría de cada producto.
 *
 * Toda la agregación y valoración vive en inventoryMath.ts (puro y testeado).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { toProblem } from "../../api/problem";
import type {
  InventoryLot,
  InventoryLotOrigin,
  Product,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  StatCard,
  type DataTableColumn,
} from "../../components";
import { fmtBps, fmtDateTime, fmtMoney, fmtQty, truncId } from "../../lib/format";
import { PRODUCT_CATEGORY_LABEL } from "../catalog/labels";
import {
  groupLotsByProduct,
  inventoryTotals,
  lotValueCents,
  type ProductPosition,
} from "./inventoryMath";
import styles from "./InventoryPage.module.css";

/** Etiquetas del origen del lote (`inventory_lot.origin`). */
const ORIGIN_LABEL: Record<InventoryLotOrigin, string> = {
  initial: "Semilla",
  production: "Producción",
  purchase: "Compra",
  conversion: "Conversión",
};

/** Color del badge por origen (reutiliza los kinds existentes). */
const ORIGIN_KIND: Record<InventoryLotOrigin, "neutral" | "transformer" | "buy" | "city"> = {
  initial: "neutral",
  production: "transformer",
  purchase: "buy",
  conversion: "city",
};

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export default function InventoryPage() {
  const { status } = useAuth();
  const authenticated = status === "authenticated";

  const [search, setSearch] = useState("");

  // Guard `enabled: authenticated`: no consultar endpoints autenticados hasta
  // que el bootstrap fije el access token (mismo motivo que el resto de páginas).
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

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;

  const positions = useMemo(
    () => groupLotsByProduct(lotsQuery.data ?? []),
    [lotsQuery.data],
  );

  // Los KPIs describen SIEMPRE el inventario completo, no el filtrado.
  const totals = useMemo(() => inventoryTotals(positions), [positions]);

  const visiblePositions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return positions;
    return positions.filter((p) => {
      const name = productById.get(p.product_id)?.name ?? p.product_id;
      return name.toLowerCase().includes(q);
    });
  }, [positions, search, productById]);

  // ---- Columnas de posiciones -----------------------------------------------
  const columns: Array<DataTableColumn<ProductPosition>> = [
    {
      key: "product",
      header: "Producto",
      sortValue: (row) => productName(row.product_id),
      render: (row) => {
        const product = productById.get(row.product_id);
        return (
          <span className={styles["cellProduct"]}>
            <Link to={`/market/${row.product_id}`} className={styles["productLink"]}>
              {productName(row.product_id)}
            </Link>
            {product !== undefined && (
              <Badge kind={product.category}>
                {PRODUCT_CATEGORY_LABEL[product.category]}
              </Badge>
            )}
            <CopyId id={row.product_id} />
          </span>
        );
      },
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
      header: "Reservado",
      align: "right",
      mono: true,
      render: (row) =>
        row.qty_reserved_cent > 0 ? (
          <span title="Comprometido en órdenes de venta activas; vuelve a disponible si se cancelan o expiran">
            {fmtQty(row.qty_reserved_cent, productUnit(row.product_id))}
          </span>
        ) : (
          <span className={styles["subtle"]}>—</span>
        ),
    },
    {
      key: "qty_total_cent",
      header: "Total",
      align: "right",
      mono: true,
      render: (row) => fmtQty(row.qty_total_cent, productUnit(row.product_id)),
    },
    {
      key: "avg_unit_cost_cents",
      header: "Coste medio",
      align: "right",
      mono: true,
      render: (row) => (
        <span title="Media ponderada del coste de los lotes en stock">
          {fmtMoney(row.avg_unit_cost_cents)}
        </span>
      ),
    },
    {
      key: "value_cents",
      header: "Valor a coste",
      align: "right",
      mono: true,
      render: (row) => fmtMoney(row.value_cents),
    },
    {
      key: "lots",
      header: "Lotes",
      align: "right",
      mono: true,
      sortValue: (row) => row.lots.length,
      render: (row) => row.lots.length,
    },
  ];

  // ---- Columnas del detalle de lotes ----------------------------------------
  const lotColumns = (productId: string): Array<DataTableColumn<InventoryLot>> => [
    {
      key: "lot_id",
      header: "Lote",
      render: (lot) => <CopyId id={lot.lot_id} />,
    },
    {
      key: "origin",
      header: "Origen",
      render: (lot) => (
        <Badge kind={ORIGIN_KIND[lot.origin]}>{ORIGIN_LABEL[lot.origin]}</Badge>
      ),
    },
    {
      key: "qty_original_cent",
      header: "Original",
      align: "right",
      mono: true,
      render: (lot) => fmtQty(lot.qty_original_cent, productUnit(productId)),
    },
    {
      key: "qty_available_cent",
      header: "Disponible",
      align: "right",
      mono: true,
      render: (lot) => fmtQty(lot.qty_available_cent),
    },
    {
      key: "qty_reserved_cent",
      header: "Reservado",
      align: "right",
      mono: true,
      render: (lot) => fmtQty(lot.qty_reserved_cent),
    },
    {
      key: "unit_cost_cents",
      header: "Coste unitario",
      align: "right",
      mono: true,
      render: (lot) => fmtMoney(lot.unit_cost_cents),
    },
    {
      key: "value",
      header: "Valor",
      align: "right",
      mono: true,
      sortValue: (lot) => lotValueCents(lot),
      render: (lot) => fmtMoney(lotValueCents(lot)),
    },
    {
      key: "acquired_at",
      header: "Adquirido",
      mono: true,
      sortValue: (lot) => Date.parse(lot.acquired_at),
      render: (lot) => fmtDateTime(lot.acquired_at),
    },
  ];

  const renderLots = (row: ProductPosition) => (
    <div className={styles["lotsPanel"]}>
      <p className={styles["lotsTitle"]}>
        Lotes de {productName(row.product_id)}{" "}
        <span className={styles["subtle"]}>
          (en orden FIFO: el primero es el próximo en consumirse)
        </span>
      </p>
      <DataTable
        columns={lotColumns(row.product_id)}
        rows={row.lots}
        rowKey={(lot) => lot.lot_id}
        caption={`Lotes de ${productName(row.product_id)} con origen, cantidades, coste unitario y fecha de adquisición`}
      />
    </div>
  );

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Inventario</h1>
        <p className={styles["lede"]}>
          Existencias por producto, valoradas al coste FIFO de sus lotes.
        </p>
      </div>

      <div className={styles["statGrid"]}>
        <StatCard
          label="Valor a coste"
          value={fmtMoney(totals.value_cents)}
          hint="Suma de los lotes en stock (disponible + reservado)"
        />
        <StatCard label="Productos" value={totals.product_count} hint="Con stock" />
        <StatCard label="Lotes" value={totals.lot_count} hint="Partidas FIFO abiertas" />
        <StatCard
          label="Reservado"
          value={fmtBps(totals.reserved_bps)}
          hint="Comprometido en órdenes de venta"
        />
      </div>

      {lotsQuery.isError ? (
        <>
          <ErrorBanner problem={toProblem(lotsQuery.error)} />
          <div>
            <button
              type="button"
              className={cx(styles["btn"], styles["btnPrimary"])}
              onClick={() => void lotsQuery.refetch()}
            >
              Reintentar
            </button>
          </div>
        </>
      ) : (
        <section className={styles["panel"]} aria-labelledby="inv-positions">
          <div className={styles["panelHead"]}>
            <h2 id="inv-positions" className={styles["panelTitle"]}>
              Posiciones
            </h2>
            <input
              type="search"
              className={styles["search"]}
              placeholder="Filtrar por producto…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Filtrar posiciones por nombre de producto"
            />
          </div>
          <DataTable
            columns={columns}
            rows={visiblePositions}
            loading={lotsQuery.isPending}
            sortable
            rowKey={(row) => row.product_id}
            renderExpanded={renderLots}
            expandLabel={(row) => `Ver lotes de ${productName(row.product_id)}`}
            caption="Posiciones de inventario con cantidades, coste medio y valor a coste; cada fila despliega sus lotes"
            empty={
              search.trim() !== "" ? (
                <EmptyState
                  title="Sin productos con ese nombre"
                  hint="Prueba con otro término."
                />
              ) : (
                <EmptyState
                  title="Todavía no tienes inventario"
                  hint="Produce con una receta o compra en el mercado."
                />
              )
            }
          />
          <p className={styles["footNote"]}>
            La cantidad reservada está comprometida en órdenes de venta activas:
            si se cancelan o expiran, vuelve íntegra a disponible.
          </p>
        </section>
      )}
    </div>
  );
}
