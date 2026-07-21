/**
 * Integridad del GRAFO del catálogo (ADR-022) — sin DB.
 *
 * `parseSeedConfig` valida el schema y la integridad referencial, pero no la
 * forma del grafo receta→insumo. Estas invariantes son las que hacen que la
 * economía pueda arrancar desde inventario cero:
 *
 *   1. Acíclico: si A necesita B y B necesita A, nadie puede producir la
 *      primera unidad de ninguno de los dos.
 *   2. Raíz ÚNICA: lo único que nace de la nada es el agua (`pozo_agua_profundo`
 *      y `pozo_somero`). Cualquier otra receta sin insumos sería un bien creado
 *      de la nada.
 *   3. Todo producto tiene al menos una receta que lo produce.
 *   4. Ningún `final_consumption` se usa como insumo (si se usa, es intermedio).
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSeedConfig, type SeedConfig } from "../../../src/seed";

const ROOT_PRODUCT = "agua";

async function loadCatalog(): Promise<SeedConfig> {
  const raw = await readFile(resolve(import.meta.dir, "../../../../infra/seed-config.json"), "utf8");
  return parseSeedConfig(raw);
}

describe("grafo del catálogo", () => {
  test("las únicas recetas sin insumos producen la raíz (agua)", async () => {
    const cfg = await loadCatalog();
    const roots = cfg.recipes.filter((r) => r.inputs.length === 0);
    expect(roots.length).toBeGreaterThan(0);
    expect([...new Set(roots.map((r) => r.output))]).toEqual([ROOT_PRODUCT]);
  });

  test("todo producto tiene al menos una receta que lo produce", async () => {
    const cfg = await loadCatalog();
    const produced = new Set(cfg.recipes.map((r) => r.output));
    const huerfanos = cfg.products.map((p) => p.key).filter((k) => !produced.has(k));
    expect(huerfanos).toEqual([]);
  });

  test("el grafo receta→insumo es acíclico", async () => {
    const cfg = await loadCatalog();
    const inputsOf = new Map<string, string[]>();
    for (const r of cfg.recipes) {
      const prev = inputsOf.get(r.output) ?? [];
      inputsOf.set(r.output, [...prev, ...r.inputs.map((i) => i.product)]);
    }
    const estado = new Map<string, "visitando" | "ok">();
    const ciclos: string[] = [];
    const visitar = (producto: string, pila: string[]): void => {
      if (estado.get(producto) === "ok") return;
      if (estado.get(producto) === "visitando") {
        ciclos.push([...pila.slice(pila.indexOf(producto)), producto].join(" → "));
        return;
      }
      estado.set(producto, "visitando");
      for (const dep of inputsOf.get(producto) ?? []) visitar(dep, [...pila, producto]);
      estado.set(producto, "ok");
    };
    for (const p of cfg.products) visitar(p.key, []);
    expect(ciclos).toEqual([]);
  });

  test("ningún final_consumption se usa como insumo", async () => {
    const cfg = await loadCatalog();
    const finales = new Set(
      cfg.products.filter((p) => p.category === "final_consumption").map((p) => p.key),
    );
    const usados = cfg.recipes.flatMap((r) =>
      r.inputs.filter((i) => finales.has(i.product)).map((i) => `${r.key}←${i.product}`),
    );
    expect(usados).toEqual([]);
  });

  test("las extractivas gastan entre el 25% y el 35% de su coste en insumos", async () => {
    const cfg = await loadCatalog();
    // Precio derivado por propagación de coste (el mismo criterio que
    // src/scripts/generate-bot-prices.ts): permite medir la cuota de insumos.
    const byOutput = new Map<string, SeedConfig["recipes"]>();
    for (const r of cfg.recipes) byOutput.set(r.output, [...(byOutput.get(r.output) ?? []), r]);
    const precio = new Map<string, number>();
    const precioDe = (key: string): number => {
      const cached = precio.get(key);
      if (cached !== undefined) return cached;
      const costes = (byOutput.get(key) ?? []).map(
        (r) => costeEjecucion(r) / (r.output_qty_cent / 100),
      );
      const p = Math.max(1, Math.round(Math.min(...costes)));
      precio.set(key, p);
      return p;
    };
    const costeInsumos = (r: SeedConfig["recipes"][number]): number =>
      r.inputs.reduce((acc, i) => acc + (i.qty_cent / 100) * precioDe(i.product), 0);
    const costeEjecucion = (r: SeedConfig["recipes"][number]): number =>
      costeInsumos(r) + r.wage_rate_cents_per_sec * r.duration_sim_seconds;

    // Solo las extractivas: aguas abajo la cuota de insumos es naturalmente
    // mucho mayor (cada eslabón añade valor sobre insumos ya caros).
    // `mineria_oro` va deliberadamente por debajo de la banda: su coste unitario
    // debe quedar bajo el window_bid del banco central o se para la acuñación;
    // las dos recetas de agua son la raíz y no tienen insumos por definición.
    const EXTRACTIVOS = new Set(["campo", "granja", "mina", "cantera", "pozo", "bosque"]);
    const excepciones = new Set(["mineria_oro"]);
    const fuera = cfg.recipes
      .filter((r) => EXTRACTIVOS.has(r.installation_type) && !excepciones.has(r.key))
      .map((r) => ({ key: r.key, cuota: costeInsumos(r) / costeEjecucion(r) }))
      .filter((x) => x.cuota < 0.25 || x.cuota > 0.35)
      .map((x) => `${x.key}=${Math.round(x.cuota * 100)}%`);
    expect(fuera).toEqual([]);
  });
});
