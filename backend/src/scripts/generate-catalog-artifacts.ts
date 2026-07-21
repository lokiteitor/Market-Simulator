/**
 * Regenera todo lo que se DERIVA del catálogo (`infra/seed-config.json`, fuente
 * única):
 *
 *   1. el bloque `prices:` de `bots-v1/config.yaml` y `bots-ciudad/config.yaml`
 *      (el mismo en los dos: si divergen, los bots de mercado y las ciudades
 *      valoran distinto el mismo producto);
 *   2. las tablas §3-§5 de `docs/catalogo_productos_recetas.md` (tipos de
 *      instalación, productos con su precio base, y recetas con el coste de una
 *      ejecución y la cuota que se va en insumos).
 *
 *   bun src/scripts/generate-catalog-artifacts.ts            # reescribe
 *   bun src/scripts/generate-catalog-artifacts.ts --check    # solo informa (CI)
 *
 * Los precios base NO son una tabla de mercado: son el COSTE de producción
 * propagado por la cadena (`seed/catalog-costs.ts`), que es lo que los bots usan
 * como ancla del fair value y como suelo de venta.
 *
 * Además imprime las dos calibraciones que hay que vigilar al tocar el catálogo:
 *   - la cuota de insumos de las recetas extractivas (banda 25-35%, ADR-022);
 *   - el coste unitario del oro, que DEBE quedar por debajo del `window_bid` del
 *     banco central o se para la acuñación (ver infra/.env.docker).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { catalogCosts, parseSeedConfig, type SeedConfig } from "../seed";

type Recipe = SeedConfig["recipes"][number];

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SEED_CONFIG = resolve(REPO_ROOT, "infra/seed-config.json");
const YAML_TARGETS = ["bots-v1/config.yaml", "bots-ciudad/config.yaml"];
const CATALOG_DOC = "docs/catalogo_productos_recetas.md";
/** Tipos de instalación extractivos: los que deben respetar la banda de insumos. */
const EXTRACTIVOS = new Set(["campo", "granja", "mina", "cantera", "pozo", "bosque"]);
/** Ver §6 del catálogo: el oro va por debajo de la banda a propósito. */
const GOLD_KEY = "oro";

const checkOnly = process.argv.includes("--check");

const cfg = parseSeedConfig(await readFile(SEED_CONFIG, "utf8"));
const costs = catalogCosts(cfg);

// --- Bloque `prices:` de los bots -------------------------------------------

const SECCIONES = [
  { category: "raw_primary", title: "Materias primas", docTitle: "`raw_primary` — Recursos naturales extraídos" },
  { category: "intermediate", title: "Intermedios", docTitle: "`intermediate` — Bienes intermedios" },
  { category: "final_consumption", title: "Consumo final", docTitle: "`final_consumption` — Productos finales" },
] as const;

const productosDe = (category: string): SeedConfig["products"] =>
  cfg.products.filter((p) => p.category === category);

const bloquePrecios = [
  "prices:",
  ...SECCIONES.flatMap((s) => [
    `  # --- ${s.title} ---`,
    ...productosDe(s.category).map((p) => `  ${p.key}: ${costs.unitPriceCents(p.key)}`),
  ]),
].join("\n");

/**
 * Sustituye el bloque `prices:` conservando TODO lo que viene detrás (líneas en
 * blanco, comentarios de nivel 0 y la sección `bots:`). El bloque termina en la
 * última línea indentada consecutiva.
 */
function reemplazarBloque(yaml: string, nuevo: string): string {
  const inicio = yaml.indexOf("\nprices:\n");
  if (inicio < 0) throw new Error("no se encontró el bloque `prices:` en el YAML");
  const desde = inicio + 1;
  const resto = yaml.slice(desde).split("\n");
  let hasta = desde + resto[0]!.length + 1; // tras la línea `prices:`
  let finBloque = hasta;
  for (const linea of resto.slice(1)) {
    if (linea.length > 0 && !linea.startsWith(" ")) break;
    hasta += linea.length + 1;
    if (linea.startsWith(" ")) finBloque = hasta;
  }
  return `${yaml.slice(0, desde)}${nuevo}\n${yaml.slice(finBloque)}`;
}

// --- Tablas §3-§5 del catálogo ----------------------------------------------

const insumosDe = (r: Recipe): string =>
  r.inputs.length === 0
    ? "—"
    : r.inputs.map((i) => `\`${i.product}\`×${i.qty_cent}`).join(", ");

function tablasCatalogo(): string {
  const out: string[] = [];

  out.push("## 3. Tipos de instalación actuales\n");
  out.push(
    `Los ${cfg.installation_types.length} tipos pertenecen al rol \`transformer\`, el único rol productivo (ADR-022).\n`,
  );
  out.push("| key | Nombre | Recetas | Precio base (¢) | Growth (bps) | Nivel máx |");
  out.push("| --- | ------ | ------- | --------------- | ------------ | --------- |");
  for (const t of cfg.installation_types) {
    out.push(
      `| \`${t.key}\` | ${t.name} | ${t.recipes.length} | ${t.base_price_cents} | ${t.growth_bps} | ${t.max_level} |`,
    );
  }
  out.push("");

  const finitos = cfg.products.filter((p) => p.finite === true);
  out.push("## 4. Productos actuales\n");
  out.push(
    "Formato: **key** · Nombre · Unidad · **precio base** (¢/unidad, derivado del coste; " +
      `§6) · **Yacimiento** (ADR-023: ✔ = recurso no renovable con stock finito, ` +
      `cuyo rendimiento decae al vaciarse). (${cfg.products.length} productos, ` +
      `${finitos.length} con yacimiento más el oro, que lo recibe del patrón oro.)\n`,
  );
  SECCIONES.forEach((s, i) => {
    out.push(`### 4.${i + 1} ${s.docTitle}\n`);
    out.push("| key | Nombre | Unidad | Precio (¢) | Yacimiento |");
    out.push("| --- | ------ | ------ | ---------- | ---------- |");
    for (const p of productosDe(s.category)) {
      out.push(
        `| \`${p.key}\` | ${p.name} | ${p.unit} | ${costs.unitPriceCents(p.key)} | ` +
          `${p.finite === true ? "✔" : "—"} |`,
      );
    }
    out.push("");
  });

  out.push("## 5. Recetas actuales (agrupadas por tipo de instalación)\n");
  out.push(
    "Formato: **key** · Nombre · Salida (`output` × `output_qty_cent`) · Duración\n" +
      "(segundos simulados) · Salario (¢/s) · **Coste** de una ejecución (¢, insumos +\n" +
      "salario) y **qué fracción de ese coste son insumos** · Insumos (`key×qty_cent`).\n" +
      "Las dos únicas recetas sin insumos (—, cuota 0%) son las del agua, la raíz del\n" +
      "catálogo.\n",
  );
  const recetaPorKey = new Map(cfg.recipes.map((r) => [r.key, r]));
  cfg.installation_types.forEach((t, i) => {
    out.push(`### 5.${i + 1} \`${t.key}\` — ${t.name}\n`);
    out.push(
      "| Receta | Nombre | Salida | Qty | Dur (s sim) | Sal | Coste ejec (¢) | Ins % | Insumos |",
    );
    out.push(
      "| ------ | ------ | ------ | --- | ----------- | --- | -------------- | ----- | ------- |",
    );
    for (const rk of t.recipes) {
      const r = recetaPorKey.get(rk);
      if (r === undefined) throw new Error(`el tipo "${t.key}" lista una receta inexistente: ${rk}`);
      out.push(
        `| \`${r.key}\` | ${r.name} | \`${r.output}\` | ${r.output_qty_cent} | ` +
          `${r.duration_sim_seconds} | ${r.wage_rate_cents_per_sec} | ` +
          `${Math.round(costs.execCostCents(r))} | ${Math.round(costs.inputsShare(r) * 100)}% | ` +
          `${insumosDe(r)} |`,
      );
    }
    out.push("");
  });

  return out.join("\n");
}

function reemplazarTablas(doc: string, nuevo: string): string {
  const inicio = doc.indexOf("## 3. Tipos de instalación actuales");
  const fin = doc.indexOf("## 6. Guía de parámetros numéricos");
  if (inicio < 0 || fin < 0) {
    throw new Error("no se encontraron las secciones §3-§5 en el catálogo (¿cambió el índice?)");
  }
  return `${doc.slice(0, inicio)}${nuevo}\n---\n\n${doc.slice(fin)}`;
}

// --- Escritura ---------------------------------------------------------------

const salidas: Array<{ rel: string; nuevo: (actual: string) => string }> = [
  ...YAML_TARGETS.map((rel) => ({
    rel,
    nuevo: (actual: string) => reemplazarBloque(actual, bloquePrecios),
  })),
  { rel: CATALOG_DOC, nuevo: (actual: string) => reemplazarTablas(actual, tablasCatalogo()) },
];

let desactualizados = 0;
for (const { rel, nuevo } of salidas) {
  const path = resolve(REPO_ROOT, rel);
  const actual = await readFile(path, "utf8");
  const contenido = nuevo(actual);
  if (contenido === actual) {
    console.log(`  = ${rel} (sin cambios)`);
    continue;
  }
  desactualizados += 1;
  if (checkOnly) {
    console.log(`  ! ${rel} DESACTUALIZADO`);
    continue;
  }
  await writeFile(path, contenido, "utf8");
  console.log(`  → ${rel} actualizado`);
}

// --- Calibraciones ----------------------------------------------------------

console.log(`\n${cfg.products.length} productos, ${cfg.recipes.length} recetas.`);

const raices = cfg.recipes.filter((r) => r.inputs.length === 0);
console.log(
  `raíces (recetas sin insumos): ${raices.map((r) => r.key).join(", ")} ` +
    `→ ${[...new Set(raices.map((r) => r.output))].join(", ")}`,
);

console.log("\ncuota de insumos sobre el coste de ejecución (extractivas, banda 25-35%):");
const fueraDeBanda: string[] = [];
for (const r of cfg.recipes) {
  if (!EXTRACTIVOS.has(r.installation_type)) continue;
  const cuota = costs.inputsShare(r);
  const pct = `${(cuota * 100).toFixed(0)}%`;
  const marca = cuota < 0.25 || cuota > 0.35 ? " ←" : "";
  if (marca !== "" && r.output !== GOLD_KEY) fueraDeBanda.push(`${r.key}=${pct}`);
  console.log(`  ${r.key.padEnd(22)} ${pct.padStart(4)}${marca}`);
}

const unidadOro = cfg.products.find((p) => p.key === GOLD_KEY)?.unit ?? "unidad";
console.log(
  `\ncoste unitario del oro: ${costs.unitPriceCents(GOLD_KEY)} ¢/${unidadOro}` +
    " — DEBE quedar bajo el window_bid del banco (ver infra/.env.docker).",
);

if (fueraDeBanda.length > 0) {
  console.log(`\nAVISO: extractivas fuera de banda: ${fueraDeBanda.join(", ")}`);
}
if (checkOnly && desactualizados > 0) {
  console.error(`\n${desactualizados} artefacto(s) desactualizado(s): corre el script sin --check.`);
  process.exit(1);
}
