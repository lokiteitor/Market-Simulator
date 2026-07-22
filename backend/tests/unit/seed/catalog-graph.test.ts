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
 *   5. Los recursos con yacimiento finito (ADR-023) son exactamente los
 *      geológicos no renovables: ni el agua (raíz), ni la arena, ni el oro.
 *   6. Frontera de la fase de energía (ADR-024): la electricidad solo fluye
 *      hacia la industria; ni entra en las extractivas ni la generación
 *      consume derivados industriales.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { catalogCosts, parseSeedConfig, type SeedConfig } from "../../../src/seed";

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

  test("el conjunto de recursos con yacimiento es exactamente el esperado", async () => {
    // Guardarraíl de ADR-023. Marcar `finite` un producto es irreversible dentro
    // de una corrida: cuando se agota, su cadena entera muere. Los tres casos
    // que este test impide de verdad son marcar el AGUA (raíz del grafo: la
    // consumen 36 recetas), marcar la ARENA (excluida a propósito: alimenta
    // silicio, vidrio y hormigón) y marcar el ORO (su yacimiento lo siembra el
    // patrón oro, y duplicarlo revienta la PK de resource_deposit).
    const cfg = await loadCatalog();
    const finitos = cfg.products.filter((p) => p.finite === true).map((p) => p.key);
    expect([...finitos].sort()).toEqual(
      [
        "arcilla", "bauxita", "caliza", "carbon", "fosfato", "gas_natural", "hierro",
        "litio", "mineral_cobre", "niquel", "petroleo", "piedra", "plata", "sal", "uranio",
      ].sort(),
    );
    expect(finitos).not.toContain(ROOT_PRODUCT);
    expect(finitos).not.toContain("arena");
    expect(finitos).not.toContain("oro");
  });

  test("todo recurso finito es extractivo: nada renovable ni industrial se agota", async () => {
    // Un intermedio con yacimiento no tendría sentido físico (se fabrica, no se
    // extrae) y campo/granja/bosque son renovables por definición.
    const cfg = await loadCatalog();
    const tipoDeReceta = new Map(cfg.recipes.map((r) => [r.output, r.installation_type]));
    const GEOLOGICOS = new Set(["mina", "cantera", "pozo"]);
    const fuera = cfg.products
      .filter((p) => p.finite === true && !GEOLOGICOS.has(tipoDeReceta.get(p.key) ?? ""))
      .map((p) => `${p.key}=${tipoDeReceta.get(p.key)}`);
    expect(fuera).toEqual([]);
  });

  test("las extractivas gastan entre el 25% y el 35% de su coste en insumos", async () => {
    const cfg = await loadCatalog();
    const costs = catalogCosts(cfg);
    // Solo las extractivas: aguas abajo la cuota de insumos es naturalmente
    // mucho mayor (cada eslabón añade valor sobre insumos ya caros).
    // `mineria_oro` va deliberadamente por debajo de la banda: su coste unitario
    // debe quedar bajo el window_bid del banco central o se para la acuñación;
    // las dos recetas de agua son la raíz y no tienen insumos por definición.
    const EXTRACTIVOS = new Set(["campo", "granja", "mina", "cantera", "pozo", "bosque"]);
    const excepciones = new Set(["mineria_oro"]);
    const fuera = cfg.recipes
      .filter((r) => EXTRACTIVOS.has(r.installation_type) && !excepciones.has(r.key))
      .map((r) => ({ key: r.key, cuota: costs.inputsShare(r) }))
      .filter((x) => x.cuota < 0.25 || x.cuota > 0.35)
      .map((x) => `${x.key}=${Math.round(x.cuota * 100)}%`);
    expect(fuera).toEqual([]);
  });

  test("fase de energía (ADR-024): la electricidad no entra en las extractivas ni la generación quema derivados", async () => {
    // La aciclicidad ya lo implica, pero este test documenta el PORQUÉ y
    // protege la frontera de la v1: (a) si una extractiva consumiera
    // electricidad y una térmica quemara su producto, se cerraría un ciclo
    // (carbón → electricidad → carbón); (b) si la generación quemara un
    // derivado industrial (diésel), ciclaría con la industria que ahora
    // consume electricidad. Relajar esto exige el chequeo de factibilidad
    // AND-OR de la v2, no borrar el test.
    const cfg = await loadCatalog();
    const EXTRACTIVOS = new Set(["campo", "granja", "mina", "cantera", "pozo", "pozo_agua", "bosque"]);
    const extractivasConElec = cfg.recipes
      .filter((r) => EXTRACTIVOS.has(r.installation_type))
      .filter((r) => r.inputs.some((i) => i.product === "electricidad"))
      .map((r) => r.key);
    expect(extractivasConElec).toEqual([]);

    const COMBUSTIBLES_PRIMARIOS = new Set(["agua", "carbon", "gas_natural"]);
    const generacionFuera = cfg.recipes
      .filter((r) => r.installation_type === "generacion")
      .flatMap((r) => r.inputs.filter((i) => !COMBUSTIBLES_PRIMARIOS.has(i.product)).map((i) => `${r.key}←${i.product}`));
    expect(generacionFuera).toEqual([]);
  });
});
