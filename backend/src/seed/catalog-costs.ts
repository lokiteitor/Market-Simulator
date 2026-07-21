/**
 * Economía derivada del catálogo: propagación de coste por la cadena.
 *
 * Los precios base que usan los bots NO son una tabla de mercado: son el COSTE
 * de producción propagado, que es lo que usan como ancla del fair value y como
 * suelo de venta. De aquí salen los tres consumidores que tienen que dar el
 * mismo número: el generador del bloque `prices:` de los bots, el generador de
 * las tablas de `docs/catalogo_productos_recetas.md`, y los tests que vigilan
 * que ninguno de los dos se desvíe del catálogo.
 *
 *   precio(p) = min sobre las recetas que producen p de
 *               (Σ insumos + wage_rate × duration_sim) / (output_qty_cent / 100)
 *
 * redondeado half-up con suelo de 1 céntimo (los precios son enteros).
 */
import type { SeedConfig } from "./seed-config";

type Recipe = SeedConfig["recipes"][number];

export interface CatalogCosts {
  /** Precio base (¢/unidad) del producto: su coste unitario más barato. */
  unitPriceCents(productKey: string): number;
  /** Coste de UNA ejecución de la receta (¢): insumos a precio base + salario. */
  execCostCents(recipe: Recipe): number;
  /** Parte del coste de ejecución que se va en insumos (¢). */
  inputsCostCents(recipe: Recipe): number;
  /** Fracción de `execCostCents` que son insumos (0 en las recetas raíz). */
  inputsShare(recipe: Recipe): number;
}

/**
 * Construye las funciones de coste del catálogo. Lanza si el grafo tiene un
 * ciclo (con la traza) o si algún producto no tiene receta que lo produzca:
 * ambos casos impedirían que el mundo produjera su primera unidad desde
 * inventario cero.
 */
export function catalogCosts(cfg: SeedConfig): CatalogCosts {
  const byOutput = new Map<string, Recipe[]>();
  for (const r of cfg.recipes) byOutput.set(r.output, [...(byOutput.get(r.output) ?? []), r]);

  const precio = new Map<string, number>();

  const unitPriceCents = (key: string, pila: readonly string[] = []): number => {
    const cached = precio.get(key);
    if (cached !== undefined) return cached;
    if (pila.includes(key)) {
      throw new Error(
        `ciclo en el grafo del catálogo: ${[...pila.slice(pila.indexOf(key)), key].join(" → ")}`,
      );
    }
    const recetas = byOutput.get(key);
    if (recetas === undefined || recetas.length === 0) {
      throw new Error(`el producto "${key}" no tiene ninguna receta que lo produzca`);
    }
    const unitarios = recetas.map(
      (r) => execCost(r, [...pila, key]) / (r.output_qty_cent / 100),
    );
    const p = Math.max(1, Math.round(Math.min(...unitarios)));
    precio.set(key, p);
    return p;
  };

  const inputsCost = (r: Recipe, pila: readonly string[] = []): number =>
    r.inputs.reduce((acc, i) => acc + (i.qty_cent / 100) * unitPriceCents(i.product, pila), 0);

  const execCost = (r: Recipe, pila: readonly string[] = []): number =>
    inputsCost(r, pila) + r.wage_rate_cents_per_sec * r.duration_sim_seconds;

  return {
    unitPriceCents: (key) => unitPriceCents(key),
    execCostCents: (r) => execCost(r),
    inputsCostCents: (r) => inputsCost(r),
    inputsShare: (r) => {
      const coste = execCost(r);
      return coste === 0 ? 0 : inputsCost(r) / coste;
    },
  };
}
