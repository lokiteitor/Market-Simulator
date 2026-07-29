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
 *   4.b Toda receta llega a un consumo final: sin comprador al otro extremo de
 *      la cadena, producir solo quema capital.
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

  test("toda receta llega a consumo final: no hay callejones sin salida", async () => {
    // Las ciudades son la ÚNICA demanda final (ADR-025) y solo compran
    // `final_consumption`. Un producto que no llega hasta ahí —ni directamente
    // ni a través de otras recetas— solo puede quemar capital: el bot paga
    // insumos y salario y se queda el lote en el almacén para siempre.
    //
    // El test mira hacia ADELANTE (¿alguien lo compra al final?), que es lo
    // contrario del test de huérfanos (¿alguien lo produce?). Retirar una
    // receta consumidora sin darse cuenta mata la cadena entera que la
    // alimentaba, y eso es exactamente lo que pasó al quitar la línea de
    // construcción: 30 de 135 productos se quedaron sin salida en silencio.
    const cfg = await loadCatalog();
    const utiles = new Set(
      cfg.products.filter((p) => p.category === "final_consumption").map((p) => p.key),
    );
    for (let cambio = true; cambio; ) {
      cambio = false;
      for (const r of cfg.recipes) {
        if (!utiles.has(r.output)) continue;
        for (const i of r.inputs) {
          if (!utiles.has(i.product)) {
            utiles.add(i.product);
            cambio = true;
          }
        }
      }
    }
    const sinSalida = cfg.recipes.filter((r) => !utiles.has(r.output)).map((r) => `${r.key}→${r.output}`);
    expect(sinSalida).toEqual([]);
  });

  test("el catálogo real declara exactamente un bien de inversión urbano", async () => {
    // ADR-029: la ciudad absorbe `housing` para crecer, y con dos bienes de
    // inversión los habitantes por unidad serían ambiguos. `parseSeedConfig`
    // solo prohíbe que haya más de uno (un catálogo reducido sin vivienda es
    // legítimo, el E2E usa uno); que EXISTA se exige aquí, sobre el catálogo
    // real: sin él la población de todas las ciudades se queda en el suelo y la
    // construcción se queda sin demanda.
    const cfg = await loadCatalog();
    const housing = cfg.products.filter((p) => p.urban === "housing").map((p) => p.key);
    expect(housing).toEqual(["vivienda"]);
  });

  test("la cesta urbana la forman todos los demás bienes de consumo final", async () => {
    // El papel urbano tiene default implícito (`basket`) justo para que añadir un
    // bien de consumo al catálogo lo meta en la cesta sin tocar nada más. Este
    // test fija la consecuencia: NINGÚN `final_consumption` puede quedar fuera de
    // la demanda urbana, porque las ciudades son la única salida (ADR-025).
    const cfg = await loadCatalog();
    const finales = cfg.products.filter((p) => p.category === "final_consumption");
    const cesta = finales.filter((p) => (p.urban ?? "basket") === "basket");
    expect(cesta.length).toBe(finales.length - 1); // todos menos la vivienda
    expect(finales.length).toBeGreaterThan(40);
  });

  test("ningún producto no-final declara papel urbano", async () => {
    // Lo replica un CHECK del DDL; aquí se detecta antes de tocar la DB.
    const cfg = await loadCatalog();
    const invalidos = cfg.products
      .filter((p) => p.urban !== undefined && p.category !== "final_consumption")
      .map((p) => p.key);
    expect(invalidos).toEqual([]);
  });

  test("el conjunto de recursos con yacimiento es exactamente el esperado", async () => {
    // Guardarraíl de ADR-023. Marcar `finite` un producto es irreversible dentro
    // de una corrida: cuando se agota, su cadena entera muere. Los tres casos
    // que este test impide de verdad son marcar el AGUA (raíz del grafo: la
    // consumen 45 recetas), marcar la ARENA (excluida a propósito: alimenta
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

    // El uranio entra en la lista por la nuclear: es un recurso geológico que
    // solo produce la `mina`, y las extractivas no consumen electricidad, así
    // que no cierra ciclo. Como es finito (ADR-023), la nuclear se apaga igual
    // que las térmicas y la hidro sigue siendo la última generación en pie.
    const COMBUSTIBLES_PRIMARIOS = new Set(["agua", "carbon", "gas_natural", "uranio"]);
    const generacionFuera = cfg.recipes
      .filter((r) => r.installation_type === "generacion")
      .flatMap((r) => r.inputs.filter((i) => !COMBUSTIBLES_PRIMARIOS.has(i.product)).map((i) => `${r.key}←${i.product}`));
    expect(generacionFuera).toEqual([]);
  });
});
