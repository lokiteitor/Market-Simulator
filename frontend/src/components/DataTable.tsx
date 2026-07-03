/**
 * DataTable — tabla de datos con:
 * - sticky header (dentro de su contenedor con scroll),
 * - ordenación client-side opcional (prop `sortable`),
 * - loading → <Skeleton/>, sin filas → <EmptyState/> (o nodo custom `empty`),
 * - aria completo: caption oculto, scope="col", aria-sort, aria-busy.
 *
 * Columnas: {key, header, render?, align?, mono?} (contrato §componentes).
 * Sin `render`, la celda muestra el valor crudo de `row[key]` (— si nulo).
 */
import { useMemo, useState, type ReactNode } from "react";

import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import styles from "./DataTable.module.css";

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  align?: "left" | "center" | "right";
  /** Celda en fuente monoespaciada (números, IDs, timestamps). */
  mono?: boolean;
  /** Valor para ordenar; default: valor crudo de row[key]. */
  sortValue?: (row: T) => unknown;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  loading?: boolean;
  /**
   * Qué mostrar sin filas: string → <EmptyState title/>; nodo → tal cual.
   * Default: EmptyState "Sin datos".
   */
  empty?: ReactNode;
  /** Habilita ordenación client-side clicando cabeceras. */
  sortable?: boolean;
  /** Clave estable de fila. Default: índice. */
  rowKey?: (row: T, index: number) => string | number;
  /** Descripción accesible de la tabla (caption visualmente oculto). */
  caption?: string;
  /** Alto máximo del contenedor (activa el scroll con header pegajoso). */
  maxHeight?: string;
}

type SortDir = "asc" | "desc";

interface SortState {
  key: string;
  dir: SortDir;
}

function rawValue<T>(row: T, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

function compareValues(a: unknown, b: unknown): number {
  const aNil = a === null || a === undefined;
  const bNil = b === null || b === undefined;
  if (aNil && bNil) return 0;
  if (aNil) return 1; // nulos al final
  if (bNil) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true });
}

function defaultCell(value: unknown): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return String(value);
}

export function DataTable<T>({
  columns,
  rows,
  loading = false,
  empty,
  sortable = false,
  rowKey,
  caption,
  maxHeight,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);

  const sortedRows = useMemo(() => {
    if (!sortable || sort === null) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const getValue = col.sortValue ?? ((row: T) => rawValue(row, col.key));
    const sign = sort.dir === "asc" ? 1 : -1;
    return rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const cmp = compareValues(getValue(a.row), getValue(b.row));
        return cmp !== 0 ? sign * cmp : a.i - b.i; // orden estable
      })
      .map((entry) => entry.row);
  }, [rows, columns, sortable, sort]);

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev === null || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // tercer clic: sin ordenar
    });
  };

  const emptyNode =
    typeof empty === "string" ? (
      <EmptyState title={empty} />
    ) : (
      (empty ?? <EmptyState title="Sin datos" />)
    );

  const alignClass = (align?: "left" | "center" | "right") =>
    align === "right"
      ? styles["alignRight"]
      : align === "center"
        ? styles["alignCenter"]
        : undefined;

  return (
    <div
      className={styles["container"]}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <table className={styles["table"]} aria-busy={loading}>
        {caption && <caption className={styles["srCaption"]}>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => {
              const sorted =
                sortable && sort !== null && sort.key === col.key ? sort : null;
              const ariaSort =
                sorted !== null
                  ? sorted.dir === "asc"
                    ? ("ascending" as const)
                    : ("descending" as const)
                  : undefined;
              const headClass = [styles["th"], alignClass(col.align)]
                .filter(Boolean)
                .join(" ");
              return (
                <th key={col.key} scope="col" aria-sort={ariaSort} className={headClass}>
                  {sortable ? (
                    <button
                      type="button"
                      className={styles["sortBtn"]}
                      onClick={() => toggleSort(col.key)}
                    >
                      <span>{col.header}</span>
                      <span className={styles["sortArrow"]} aria-hidden="true">
                        {sorted !== null
                          ? sorted.dir === "asc"
                            ? "▲"
                            : "▼"
                          : "↕"}
                      </span>
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className={styles["stateCell"]}>
                <Skeleton rows={4} />
              </td>
            </tr>
          ) : sortedRows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles["stateCell"]}>
                {emptyNode}
              </td>
            </tr>
          ) : (
            sortedRows.map((row, i) => (
              <tr key={rowKey ? rowKey(row, i) : i} className={styles["row"]}>
                {columns.map((col) => {
                  const cellClass = [
                    styles["td"],
                    alignClass(col.align),
                    col.mono ? styles["mono"] : undefined,
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <td key={col.key} className={cellClass}>
                      {col.render ? col.render(row) : defaultCell(rawValue(row, col.key))}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
