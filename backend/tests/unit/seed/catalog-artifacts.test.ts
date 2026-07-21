/**
 * Los artefactos DERIVADOS del catálogo no se han quedado atrás — sin DB.
 *
 * `infra/seed-config.json` es la fuente única, y de ella salen por propagación
 * de coste (`src/scripts/generate-catalog-artifacts.ts`):
 *   - el bloque `prices:` de `bots-v1/config.yaml` y `bots-ciudad/config.yaml`
 *     (el MISMO en los dos);
 *   - las tablas §3-§5 de `docs/catalogo_productos_recetas.md`.
 *
 * Si alguien toca el catálogo y no regenera, los bots valoran con costes viejos
 * —producen a pérdida o dejan de producir— y la documentación miente. Este test
 * es el guardia de esa deriva: si falla, corre el generador.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { catalogCosts, parseSeedConfig, type SeedConfig } from "../../../src/seed";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

async function catalogo(): Promise<SeedConfig> {
  return parseSeedConfig(await readFile(resolve(REPO_ROOT, "infra/seed-config.json"), "utf8"));
}

async function leer(rel: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, rel), "utf8");
}

/** Precios del bloque `prices:` de un YAML de bots. */
function preciosDelYaml(raw: string): Map<string, number> {
  const bloque = raw.slice(raw.indexOf("\nprices:\n") + 1);
  const precios = new Map<string, number>();
  for (const linea of bloque.split("\n").slice(1)) {
    if (linea.length > 0 && !linea.startsWith(" ")) break;
    const m = /^ {2}([a-z0-9_]+): (\d+)$/.exec(linea);
    if (m !== null) precios.set(m[1]!, Number(m[2]));
  }
  return precios;
}

describe("artefactos derivados del catálogo", () => {
  test("bots-v1 y bots-ciudad llevan el mismo bloque de precios", async () => {
    const v1 = preciosDelYaml(await leer("bots-v1/config.yaml"));
    const ciudad = preciosDelYaml(await leer("bots-ciudad/config.yaml"));
    expect(Object.fromEntries(ciudad)).toEqual(Object.fromEntries(v1));
  });

  test("los precios de los bots son el coste propagado del seed-config", async () => {
    const cfg = await catalogo();
    const costs = catalogCosts(cfg);
    const esperado = Object.fromEntries(
      cfg.products.map((p) => [p.key, costs.unitPriceCents(p.key)]),
    );
    const yaml = preciosDelYaml(await leer("bots-v1/config.yaml"));
    expect(Object.fromEntries(yaml)).toEqual(esperado);
  });

  test("las tablas del catálogo listan todas las recetas con sus números", async () => {
    const cfg = await catalogo();
    const costs = catalogCosts(cfg);
    const doc = await leer("docs/catalogo_productos_recetas.md");
    const desincronizadas = cfg.recipes
      .filter((r) => {
        const insumos =
          r.inputs.length === 0
            ? "—"
            : r.inputs.map((i) => `\`${i.product}\`×${i.qty_cent}`).join(", ");
        const fila =
          `| \`${r.key}\` | ${r.name} | \`${r.output}\` | ${r.output_qty_cent} | ` +
          `${r.duration_sim_seconds} | ${r.wage_rate_cents_per_sec} | ` +
          `${Math.round(costs.execCostCents(r))} | ${Math.round(costs.inputsShare(r) * 100)}% | ` +
          `${insumos} |`;
        return !doc.includes(fila);
      })
      .map((r) => r.key);
    expect(desincronizadas).toEqual([]);
  });

  test("las tablas del catálogo listan todos los productos con su precio", async () => {
    const cfg = await catalogo();
    const costs = catalogCosts(cfg);
    const doc = await leer("docs/catalogo_productos_recetas.md");
    const desincronizados = cfg.products
      .filter(
        (p) => !doc.includes(`| \`${p.key}\` | ${p.name} | ${p.unit} | ${costs.unitPriceCents(p.key)} |`),
      )
      .map((p) => p.key);
    expect(desincronizados).toEqual([]);
  });

  test("las tablas del catálogo listan todos los tipos de instalación", async () => {
    const cfg = await catalogo();
    const doc = await leer("docs/catalogo_productos_recetas.md");
    const desincronizados = cfg.installation_types
      .filter(
        (t) =>
          !doc.includes(
            `| \`${t.key}\` | ${t.name} | ${t.recipes.length} | ${t.base_price_cents} | ${t.growth_bps} | ${t.max_level} |`,
          ),
      )
      .map((t) => t.key);
    expect(desincronizados).toEqual([]);
  });
});
