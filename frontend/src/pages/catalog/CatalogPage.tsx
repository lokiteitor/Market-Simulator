/**
 * CatalogPage [FE6] — catálogo de productos y recetas (design doc §7).
 *
 * Datos (públicos, sin Authorization; también visibles autenticado):
 * - ["catalog", "products"] → GET /catalog/products
 * - ["catalog", "recipes"]  → GET /catalog/recipes
 * El catálogo es estático durante la corrida → staleTime Infinity.
 *
 * Muestra:
 * - Tabla de productos: nombre, categoría (Badge), unidad, enlace al mercado.
 * - Tabla de recetas: output con cantidad, insumos inline, duración REAL
 *   formateada legible (hint con equivalencia simulada, factor 5×) y
 *   salario por segundo.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type { Problem, Product, Recipe } from "../../api/types";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  type DataTableColumn,
} from "../../components";
import { fmtMoney, fmtQty, truncId } from "../../lib/format";
import { fmtDurationSeconds, realDurationSimHint } from "../market/simTime";
import { PRODUCT_CATEGORY_LABEL } from "./labels";
import styles from "./CatalogPage.module.css";

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

export default function CatalogPage() {
  // ---- Datos (catálogo público y estático) -----------------------------------
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

  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;

  const filteredProducts = useMemo(() => {
    const all = productsQuery.data ?? [];
    if (q === "") return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.unit.toLowerCase().includes(q) ||
        PRODUCT_CATEGORY_LABEL[p.category].toLowerCase().includes(q),
    );
  }, [productsQuery.data, q]);

  const filteredRecipes = useMemo(() => {
    const all = recipesQuery.data ?? [];
    if (q === "") return all;
    return all.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        productName(r.output_product_id).toLowerCase().includes(q) ||
        r.inputs.some((input) =>
          productName(input.product_id).toLowerCase().includes(q),
        ),
    );
    // productName es derivado puro de productById (dependencia incluida).
  }, [recipesQuery.data, q, productById]);

  // ---- Columnas: productos --------------------------------------------------------
  const productColumns: Array<DataTableColumn<Product>> = [
    {
      key: "name",
      header: "Producto",
      sortValue: (row) => row.name,
      render: (row) => (
        <span className={styles.cellName}>
          <span className={styles.name}>{row.name}</span>
          <CopyId id={row.product_id} />
        </span>
      ),
    },
    {
      key: "category",
      header: "Categoría",
      sortValue: (row) => PRODUCT_CATEGORY_LABEL[row.category],
      render: (row) => (
        <Badge kind={row.category}>{PRODUCT_CATEGORY_LABEL[row.category]}</Badge>
      ),
    },
    {
      key: "unit",
      header: "Unidad",
      mono: true,
    },
    {
      key: "market",
      header: <span className="visually-hidden">Mercado</span>,
      align: "right",
      render: (row) => (
        <Link
          className={styles.marketLink}
          to={`/market/${row.product_id}`}
          aria-label={`Ver mercado de ${row.name}`}
        >
          Ver mercado
        </Link>
      ),
    },
  ];

  // ---- Columnas: recetas -------------------------------------------------------------
  const recipeColumns: Array<DataTableColumn<Recipe>> = [
    {
      key: "name",
      header: "Receta",
      sortValue: (row) => row.name,
      render: (row) => (
        <span className={styles.cellName}>
          <span className={styles.name}>{row.name}</span>
          <CopyId id={row.recipe_id} />
        </span>
      ),
    },
    {
      key: "output",
      header: "Produce (por ejecución)",
      sortValue: (row) => productName(row.output_product_id),
      render: (row) => (
        <span className={styles.outputCell}>
          <span className={styles.mono}>
            {fmtQty(row.output_qty_cent, productUnit(row.output_product_id))}
          </span>
          <span>{productName(row.output_product_id)}</span>
        </span>
      ),
    },
    {
      key: "inputs",
      header: "Insumos (por ejecución)",
      render: (row) =>
        row.inputs.length === 0 ? (
          <span className={styles.subtle}>
            Producción primaria — sin insumos
          </span>
        ) : (
          <ul className={styles.chipList}>
            {row.inputs.map((input) => (
              <li key={input.product_id} className={styles.chip}>
                <span className={styles.mono}>
                  {fmtQty(
                    input.qty_required_cent,
                    productUnit(input.product_id),
                  )}
                </span>
                <span>{productName(input.product_id)}</span>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: "duration_seconds",
      header: "Duración (real)",
      sortValue: (row) => row.duration_seconds,
      render: (row) => (
        <span className={styles.durationCell}>
          <span className={styles.mono}>
            {fmtDurationSeconds(row.duration_seconds)}
          </span>
          <span className={styles.subtle}>
            {realDurationSimHint(row.duration_seconds)}
          </span>
        </span>
      ),
    },
    {
      key: "wage_rate_cents_per_sec",
      header: "Salario",
      align: "right",
      mono: true,
      render: (row) => (
        <span title="Salario pagado por segundo de proceso">
          {fmtMoney(row.wage_rate_cents_per_sec)}/s
        </span>
      ),
    },
  ];

  const productsCount = productsQuery.data?.length ?? 0;
  const recipesCount = recipesQuery.data?.length ?? 0;

  return (
    <div className={styles.page}>
      {/* Cabecera */}
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Catálogo</h1>
          <p className={styles.subtitle}>
            Productos y recetas de la corrida. El catálogo es público y
            estático: cualquier agente puede operar cualquier producto.
          </p>
        </div>
        <div className={styles.search}>
          <Field label="Buscar en el catálogo">
            <input
              type="search"
              placeholder="Nombre, unidad, categoría…"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Productos */}
      <section className={styles.panel} aria-labelledby="catalog-products">
        <div className={styles.panelHead}>
          <h2 id="catalog-products" className={styles.panelTitle}>
            Productos
          </h2>
          <p className={styles.panelHint}>
            {productsQuery.isPending
              ? "Cargando…"
              : q === ""
                ? `${productsCount} producto${productsCount === 1 ? "" : "s"}`
                : `${filteredProducts.length} de ${productsCount} productos`}
          </p>
        </div>
        {productsQuery.isError ? (
          <ErrorBanner problem={toProblem(productsQuery.error)} />
        ) : (
          <DataTable
            columns={productColumns}
            rows={filteredProducts}
            loading={productsQuery.isPending}
            sortable
            rowKey={(row) => row.product_id}
            caption="Productos del catálogo con categoría, unidad de medida y enlace a su mercado"
            empty={
              q === "" ? (
                <EmptyState
                  title="Catálogo vacío"
                  hint="La corrida aún no tiene productos configurados."
                />
              ) : (
                <EmptyState
                  title="Sin coincidencias"
                  hint={`Ningún producto coincide con "${search.trim()}".`}
                />
              )
            }
          />
        )}
      </section>

      {/* Recetas */}
      <section className={styles.panel} aria-labelledby="catalog-recipes">
        <div className={styles.panelHead}>
          <h2 id="catalog-recipes" className={styles.panelTitle}>
            Recetas
          </h2>
          <p className={styles.panelHint}>
            {recipesQuery.isPending
              ? "Cargando…"
              : q === ""
                ? `${recipesCount} receta${recipesCount === 1 ? "" : "s"} · duraciones en tiempo real`
                : `${filteredRecipes.length} de ${recipesCount} recetas`}
          </p>
        </div>
        {recipesQuery.isError ? (
          <ErrorBanner problem={toProblem(recipesQuery.error)} />
        ) : (
          <DataTable
            columns={recipeColumns}
            rows={filteredRecipes}
            loading={recipesQuery.isPending}
            sortable
            rowKey={(row) => row.recipe_id}
            caption="Recetas del catálogo con producto resultante, insumos por ejecución, duración real y salario por segundo"
            empty={
              q === "" ? (
                <EmptyState
                  title="Sin recetas"
                  hint="La corrida aún no tiene recetas configuradas."
                />
              ) : (
                <EmptyState
                  title="Sin coincidencias"
                  hint={`Ninguna receta coincide con "${search.trim()}".`}
                />
              )
            }
          />
        )}
      </section>
    </div>
  );
}
