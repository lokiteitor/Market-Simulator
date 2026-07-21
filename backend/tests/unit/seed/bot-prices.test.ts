/**
 * Los precios base de los bots derivan del catálogo — sin DB.
 *
 * `bots-v1/config.yaml` y `bots-ciudad/config.yaml` llevan el MISMO bloque
 * `prices:`, generado por `src/scripts/generate-bot-prices.ts` a partir de
 * `infra/seed-config.json`. Si alguien toca el catálogo y no regenera, los bots
 * valoran con costes viejos: producen a pérdida o dejan de producir. Este test
 * es el guardia de esa deriva.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSeedConfig, type SeedConfig } from "../../../src/seed";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

async function preciosDelCatalogo(): Promise<Map<string, number>> {
  const cfg = parseSeedConfig(await readFile(resolve(REPO_ROOT, "infra/seed-config.json"), "utf8"));
  const byOutput = new Map<string, SeedConfig["recipes"]>();
  for (const r of cfg.recipes) byOutput.set(r.output, [...(byOutput.get(r.output) ?? []), r]);
  const precio = new Map<string, number>();
  const precioDe = (key: string): number => {
    const cached = precio.get(key);
    if (cached !== undefined) return cached;
    const unitarios = (byOutput.get(key) ?? []).map((r) => {
      const insumos = r.inputs.reduce((acc, i) => acc + (i.qty_cent / 100) * precioDe(i.product), 0);
      return (
        (insumos + r.wage_rate_cents_per_sec * r.duration_sim_seconds) / (r.output_qty_cent / 100)
      );
    });
    const p = Math.max(1, Math.round(Math.min(...unitarios)));
    precio.set(key, p);
    return p;
  };
  return new Map(cfg.products.map((p) => [p.key, precioDe(p.key)]));
}

async function preciosDelYaml(rel: string): Promise<Map<string, number>> {
  const raw = await readFile(resolve(REPO_ROOT, rel), "utf8");
  const bloque = raw.slice(raw.indexOf("\nprices:\n") + 1);
  const precios = new Map<string, number>();
  for (const linea of bloque.split("\n").slice(1)) {
    if (linea.length > 0 && !linea.startsWith(" ")) break;
    const m = /^ {2}([a-z0-9_]+): (\d+)$/.exec(linea);
    if (m !== null) precios.set(m[1]!, Number(m[2]));
  }
  return precios;
}

describe("precios base de los bots", () => {
  test("bots-v1 y bots-ciudad llevan el mismo bloque", async () => {
    const v1 = await preciosDelYaml("bots-v1/config.yaml");
    const ciudad = await preciosDelYaml("bots-ciudad/config.yaml");
    expect(Object.fromEntries(ciudad)).toEqual(Object.fromEntries(v1));
  });

  test("coinciden con la propagación de coste del seed-config", async () => {
    const esperado = await preciosDelCatalogo();
    const yaml = await preciosDelYaml("bots-v1/config.yaml");
    expect(Object.fromEntries(yaml)).toEqual(Object.fromEntries(esperado));
  });
});
