/**
 * CatalogPage [FE6] — catálogo de productos y recetas (design doc §7).
 *
 * Datos (públicos, sin Authorization; también visibles autenticado):
 * - ["catalog", "products"] → GET /catalog/products
 * - ["catalog", "recipes"]  → GET /catalog/recipes
 * El catálogo es estático durante la corrida → staleTime Infinity.
 * - ["catalog", "deposits"] → GET /catalog/deposits — la EXCEPCIÓN dinámica
 *   (ADR-023): el remanente baja con cada extracción → refetch cada 5 s,
 *   sin staleTime (además lo invalida el WS deposit_depleted).
 *
 * Muestra:
 * - Tabla de productos: nombre, categoría (Badge) + chip Finito/Agotado si
 *   el producto tiene yacimiento, unidad, enlace al mercado.
 * - Tabla de yacimientos: remanente/inicial con barra y rendimiento actual.
 * - Tabla de recetas: output con cantidad, tipo de instalación requerido
 *   (ADR-021), insumos inline con la electricidad destacada (ADR-024),
 *   duración REAL formateada legible (hint con equivalencia simulada) y
 *   salario por segundo.
 * Filtros: buscador + categoría de producto + tipo de instalación (con 149
 * productos / 152 recetas el filtrado es imprescindible para navegar).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { toProblem } from "../../api/problem";
import type {
  Deposit,
  InstallationType,
  Product,
  ProductCategory,
  Recipe,
} from "../../api/types";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  Field,
  ProgressBar,
  type DataTableColumn,
} from "../../components";
import { fmtBps, fmtMoney, fmtQty, truncId } from "../../lib/format";
import { fmtDurationSeconds, realDurationSimHint } from "../market/simTime";
import { PRODUCT_CATEGORY_LABEL, PRODUCT_CATEGORY_ORDER } from "./labels";
import styles from "./CatalogPage.module.css";

/** key del producto electricidad (ADR-024) y del tipo generación. */
const ELECTRICITY_PRODUCT_KEY = "electricidad";
const GENERATION_TYPE_KEY = "generacion";

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

  // Yacimientos (ADR-023): único /catalog/* dinámico — sin staleTime.
  const depositsQuery = useQuery({
    queryKey: ["catalog", "deposits"],
    queryFn: ({ signal }) =>
      api.get<Deposit[]>("/catalog/deposits", { signal, auth: false }),
    refetchInterval: 5_000,
  });

  // Tipos de instalación (ADR-021): estáticos como el resto del catálogo.
  const installationTypesQuery = useQuery({
    queryKey: ["catalog", "installation-types"],
    queryFn: ({ signal }) =>
      api.get<InstallationType[]>("/catalog/installation-types", {
        signal,
        auth: false,
      }),
    staleTime: Infinity,
  });

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ProductCategory | "">("");
  const [typeFilter, setTypeFilter] = useState("");
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

  // Producto con entrada aquí = recurso finito; sin entrada = inagotable.
  const depositByProductId = useMemo(() => {
    const map = new Map<string, Deposit>();
    for (const d of depositsQuery.data ?? []) map.set(d.product_id, d);
    return map;
  }, [depositsQuery.data]);

  const typeById = useMemo(() => {
    const map = new Map<string, InstallationType>();
    for (const t of installationTypesQuery.data ?? [])
      map.set(t.installation_type_id, t);
    return map;
  }, [installationTypesQuery.data]);

  // Id del producto electricidad para destacar el insumo energético (ADR-024).
  const electricityProductId = useMemo(
    () =>
      (productsQuery.data ?? []).find((p) => p.key === ELECTRICITY_PRODUCT_KEY)
        ?.product_id ?? null,
    [productsQuery.data],
  );

  const filteredProducts = useMemo(() => {
    let all = productsQuery.data ?? [];
    if (category !== "") all = all.filter((p) => p.category === category);
    if (q === "") return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.unit.toLowerCase().includes(q) ||
        PRODUCT_CATEGORY_LABEL[p.category].toLowerCase().includes(q),
    );
  }, [productsQuery.data, q, category]);

  const filteredRecipes = useMemo(() => {
    let all = recipesQuery.data ?? [];
    if (category !== "")
      all = all.filter(
        (r) => productById.get(r.output_product_id)?.category === category,
      );
    if (typeFilter !== "")
      all = all.filter((r) => r.installation_type_id === typeFilter);
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
  }, [recipesQuery.data, q, productById, category, typeFilter]);

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
      render: (row) => {
        const deposit = depositByProductId.get(row.product_id);
        return (
          <span className={styles.badgeGroup}>
            <Badge kind={row.category}>
              {PRODUCT_CATEGORY_LABEL[row.category]}
            </Badge>
            {deposit !== undefined &&
              (deposit.yield_bps === 0 ? (
                <Badge kind="expired">Agotado</Badge>
              ) : (
                <Badge kind="neutral">Finito</Badge>
              ))}
          </span>
        );
      },
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

  // ---- Columnas: yacimientos (ADR-023) ---------------------------------------------
  const depositColumns: Array<DataTableColumn<Deposit>> = [
    {
      key: "product",
      header: "Producto",
      sortValue: (row) => productName(row.product_id),
      render: (row) => (
        <span className={styles.cellName}>
          <span className={styles.name}>{productName(row.product_id)}</span>
          <CopyId id={row.product_id} />
        </span>
      ),
    },
    {
      key: "remaining",
      header: "Restante / inicial",
      sortValue: (row) => row.qty_remaining_cent,
      render: (row) => (
        <span className={styles.depositCell}>
          <span className={styles.mono}>
            {fmtQty(row.qty_remaining_cent, productUnit(row.product_id))} /{" "}
            {fmtQty(row.qty_initial_cent, productUnit(row.product_id))}
          </span>
          <ProgressBar
            value={row.qty_remaining_cent}
            max={row.qty_initial_cent}
            label={`Remanente del yacimiento de ${productName(row.product_id)}`}
          />
        </span>
      ),
    },
    {
      key: "yield_bps",
      header: "Rendimiento",
      align: "right",
      sortValue: (row) => row.yield_bps,
      render: (row) => <span className={styles.mono}>{fmtBps(row.yield_bps)}</span>,
    },
    {
      key: "state",
      header: "Estado",
      sortValue: (row) => (row.yield_bps === 0 ? 0 : 1),
      render: (row) =>
        row.yield_bps === 0 ? (
          <Badge kind="expired">Agotado</Badge>
        ) : (
          <Badge kind="active">Activo</Badge>
        ),
    },
  ];

  const filteredDeposits = useMemo(() => {
    const all = depositsQuery.data ?? [];
    if (q === "") return all;
    return all.filter(
      (d) =>
        d.product_key.toLowerCase().includes(q) ||
        productName(d.product_id).toLowerCase().includes(q),
    );
    // productName es derivado puro de productById (dependencia incluida).
  }, [depositsQuery.data, q, productById]);

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
      key: "installation",
      header: "Instalación",
      sortValue: (row) => typeById.get(row.installation_type_id)?.name ?? "",
      render: (row) => {
        const type = typeById.get(row.installation_type_id);
        if (type === undefined)
          return <span className={styles.subtle}>—</span>;
        // La generación eléctrica se distingue de un vistazo (ADR-024).
        return (
          <Badge kind="neutral">
            {type.key === GENERATION_TYPE_KEY ? `⚡ ${type.name}` : type.name}
          </Badge>
        );
      },
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
            {row.inputs.map((input) => {
              const isElectricity = input.product_id === electricityProductId;
              return (
                <li
                  key={input.product_id}
                  className={isElectricity ? styles.chipEnergy : styles.chip}
                  title={
                    isElectricity
                      ? "Insumo energético (ADR-024): esta receta consume electricidad"
                      : undefined
                  }
                >
                  <span className={styles.mono}>
                    {fmtQty(
                      input.qty_required_cent,
                      productUnit(input.product_id),
                    )}
                  </span>
                  <span>
                    {isElectricity ? "⚡ " : ""}
                    {productName(input.product_id)}
                  </span>
                </li>
              );
            })}
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
        <div className={styles.filters}>
          <Field label="Buscar en el catálogo">
            <input
              type="search"
              placeholder="Nombre, unidad, categoría…"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="Categoría">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ProductCategory | "")}
            >
              <option value="">Todas</option>
              {PRODUCT_CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {PRODUCT_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de instalación">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">Todos</option>
              {(installationTypesQuery.data ?? []).map((t) => (
                <option key={t.installation_type_id} value={t.installation_type_id}>
                  {t.name}
                </option>
              ))}
            </select>
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

      {/* Yacimientos (ADR-023) */}
      <section className={styles.panel} aria-labelledby="catalog-deposits">
        <div className={styles.panelHead}>
          <h2 id="catalog-deposits" className={styles.panelTitle}>
            Yacimientos
          </h2>
          <p className={styles.panelHint}>
            Recursos no renovables: el remanente y el rendimiento bajan con
            cada extracción (se refresca cada 5 s). Un producto sin yacimiento
            es inagotable.
          </p>
        </div>
        {depositsQuery.isError ? (
          <ErrorBanner problem={toProblem(depositsQuery.error)} />
        ) : (
          <DataTable
            columns={depositColumns}
            rows={filteredDeposits}
            loading={depositsQuery.isPending}
            sortable
            rowKey={(row) => row.product_id}
            caption="Yacimientos finitos con remanente frente al tamaño inicial y rendimiento actual"
            empty={
              q === "" ? (
                <EmptyState
                  title="Sin yacimientos"
                  hint="Esta corrida no tiene recursos finitos configurados."
                />
              ) : (
                <EmptyState
                  title="Sin coincidencias"
                  hint={`Ningún yacimiento coincide con "${search.trim()}".`}
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
