/**
 * Genera el bloque `prices:` de los bots por propagación de coste desde
 * `infra/seed-config.json` (fuente única del catálogo).
 *
 *   bun src/scripts/generate-bot-prices.ts            # reescribe los YAML
 *   bun src/scripts/generate-bot-prices.ts --check    # solo informa (CI)
 *
 * Los precios base NO son una tabla de mercado: son el COSTE de producción
 * propagado por la cadena, que es lo que los bots usan como ancla del fair value
 * y como suelo de venta. Se calculan en orden topológico:
 *
 *   precio(p) = min sobre las recetas que producen p de
 *               (Σ insumos + wage_rate × duration_sim) / (output_qty_cent / 100)
 *
 * redondeado half-up con suelo de 1 céntimo (los precios son enteros).
 *
 * Se escriben DOS ficheros con el mismo bloque: `bots-v1/config.yaml` y
 * `bots-ciudad/config.yaml`. Si divergen, los bots de mercado y las ciudades
 * valoran distinto el mismo producto.
 *
 * Además imprime dos calibraciones que hay que vigilar al tocar el catálogo:
 *   - la cuota de insumos sobre el coste de las recetas extractivas (banda
 *     25-35%, ADR-022);
 *   - el coste unitario del oro, que DEBE quedar por debajo del `window_bid`
 *     del banco central o se para la acuñación (ver infra/.env.docker).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSeedConfig, type SeedConfig } from "../seed";

type Recipe = SeedConfig["recipes"][number];

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SEED_CONFIG = resolve(REPO_ROOT, "infra/seed-config.json");
const YAML_TARGETS = [
  resolve(REPO_ROOT, "bots-v1/config.yaml"),
  resolve(REPO_ROOT, "bots-ciudad/config.yaml"),
];
/** Tipos de instalación extractivos: los que deben respetar la banda de insumos. */
const EXTRACTIVOS = new Set(["campo", "granja", "mina", "cantera", "pozo", "bosque"]);
/** Ver §7 del ADR-022: el oro va por debajo de la banda a propósito. */
const GOLD_KEY = "oro";

const checkOnly = process.argv.includes("--check");

const cfg = parseSeedConfig(await readFile(SEED_CONFIG, "utf8"));

// --- Propagación de coste ---------------------------------------------------

const recipesByOutput = new Map<string, Recipe[]>();
for (const r of cfg.recipes) {
  recipesByOutput.set(r.output, [...(recipesByOutput.get(r.output) ?? []), r]);
}

const precio = new Map<string, number>();

function precioDe(key: string, pila: readonly string[] = []): number {
  const cached = precio.get(key);
  if (cached !== undefined) return cached;
  if (pila.includes(key)) {
    const ciclo = [...pila.slice(pila.indexOf(key)), key].join(" → ");
    throw new Error(`ciclo en el grafo del catálogo: ${ciclo}`);
  }
  const recetas = recipesByOutput.get(key);
  if (recetas === undefined || recetas.length === 0) {
    throw new Error(`el producto "${key}" no tiene ninguna receta que lo produzca`);
  }
  const unitarios = recetas.map(
    (r) => costeEjecucion(r, [...pila, key]) / (r.output_qty_cent / 100),
  );
  const p = Math.max(1, Math.round(Math.min(...unitarios)));
  precio.set(key, p);
  return p;
}

function costeInsumos(r: Recipe, pila: readonly string[] = []): number {
  return r.inputs.reduce((acc, i) => acc + (i.qty_cent / 100) * precioDe(i.product, pila), 0);
}

function costeEjecucion(r: Recipe, pila: readonly string[] = []): number {
  return costeInsumos(r, pila) + r.wage_rate_cents_per_sec * r.duration_sim_seconds;
}

for (const p of cfg.products) precioDe(p.key);

// --- Bloque YAML ------------------------------------------------------------

const SECCIONES = [
  { category: "raw_primary", title: "Materias primas" },
  { category: "intermediate", title: "Intermedios" },
  { category: "final_consumption", title: "Consumo final" },
] as const;

const lineas = ["prices:"];
for (const seccion of SECCIONES) {
  lineas.push(`  # --- ${seccion.title} ---`);
  for (const p of cfg.products) {
    if (p.category === seccion.category) lineas.push(`  ${p.key}: ${precioDe(p.key)}`);
  }
}
const bloque = lineas.join("\n");

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

let desactualizados = 0;
for (const target of YAML_TARGETS) {
  const actual = await readFile(target, "utf8");
  const nuevo = reemplazarBloque(actual, bloque);
  const rel = target.slice(REPO_ROOT.length + 1);
  if (nuevo === actual) {
    console.log(`  = ${rel} (sin cambios)`);
    continue;
  }
  desactualizados += 1;
  if (checkOnly) {
    console.log(`  ! ${rel} DESACTUALIZADO`);
    continue;
  }
  await writeFile(target, nuevo, "utf8");
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
  const cuota = costeInsumos(r) / costeEjecucion(r);
  const pct = `${(cuota * 100).toFixed(0)}%`;
  const marca = cuota < 0.25 || cuota > 0.35 ? " ←" : "";
  if (marca !== "" && r.output !== GOLD_KEY) fueraDeBanda.push(`${r.key}=${pct}`);
  console.log(`  ${r.key.padEnd(22)} ${pct.padStart(4)}${marca}`);
}

const goldRecipe = recipesByOutput.get(GOLD_KEY)?.[0];
if (goldRecipe !== undefined) {
  console.log(
    `\ncoste unitario del oro: ${precioDe(GOLD_KEY)} ¢/${
      cfg.products.find((p) => p.key === GOLD_KEY)?.unit ?? "unidad"
    }` + " — DEBE quedar bajo el window_bid del banco (ver infra/.env.docker).",
  );
}

if (fueraDeBanda.length > 0) {
  console.log(`\nAVISO: extractivas fuera de banda: ${fueraDeBanda.join(", ")}`);
}
if (checkOnly && desactualizados > 0) {
  console.error(`\n${desactualizados} YAML desactualizado(s): corre el script sin --check.`);
  process.exit(1);
}
