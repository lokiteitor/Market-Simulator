/**
 * format.ts — Helpers de formato/parseo del dominio.
 *
 * Convención de la API (specs/openapi.yaml): TODAS las magnitudes viajan como
 * enteros — cantidades en centésimas de la unidad del producto y dinero en
 * centavos. La UI NUNCA muestra esos enteros crudos: siempre divide entre 100
 * con 2 decimales, vía estos helpers.
 */

/** Agrupa la parte entera con comas de millares: 1234567 -> "1,234,567". */
function groupThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formatea un entero en centésimas como decimal con 2 dígitos y millares.
 * Aritmética entera (sin división flotante) para evitar errores de redondeo.
 */
function centsToDecimalString(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  const intPart = Math.trunc(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}${groupThousands(intPart)}.${frac}`;
}

/** Dinero en centavos -> "$1,234.56" (negativos: "-$1,234.56"). */
export function fmtMoney(cents: number): string {
  const s = centsToDecimalString(cents);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
}

/** Cantidad en centésimas -> "12.50 kg" (sin unidad: "12.50"). */
export function fmtQty(qtyCent: number, unit?: string): string {
  const s = centsToDecimalString(qtyCent);
  return unit ? `${s} ${unit}` : s;
}

/**
 * Basis points -> porcentaje con 2 decimales: 10000 -> "100.00%",
 * 6250 -> "62.50%". Aritmética entera (bps YA está en centésimas de %).
 */
export function fmtBps(bps: number): string {
  return `${centsToDecimalString(bps)}%`;
}

/** UUIDv7 (u otro id) truncado a sus primeros 8 caracteres. */
export function truncId(id: string): string {
  return id.slice(0, 8);
}

/** ISO-8601 -> fecha/hora local legible (es). "—" si el ISO es inválido. */
export function fmtDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(t));
}

/**
 * ISO-8601 -> tiempo relativo a ahora en español ("hace 5 minutos",
 * "dentro de 2 horas"). "—" si el ISO es inválido.
 */
export function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.trunc(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(diffSec / 3600), "hour");
  return rtf.format(Math.trunc(diffSec / 86400), "day");
}

/**
 * Parsea texto decimal positivo (máx. 2 decimales, millares con comas
 * opcionales bien agrupados) a entero en centésimas. null si es inválido.
 */
function parseDecimalToHundredths(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const intDigits = (m[1] ?? "").replace(/,/g, "");
  const fracDigits = m[2] ?? "";
  if (intDigits === "" && fracDigits === "") return null; // solo "."
  const value =
    Number(intDigits === "" ? "0" : intDigits) * 100 +
    Number(fracDigits === "" ? "0" : fracDigits.padEnd(2, "0"));
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Input monetario ("$1,234.56", "250", "0.05") -> centavos (entero).
 * null si es inválido (negativos, >2 decimales, texto, vacío).
 */
export function parseMoneyToCents(input: string): number | null {
  const s = input.trim();
  const body = s.startsWith("$") ? s.slice(1).trim() : s;
  return parseDecimalToHundredths(body);
}

/**
 * Input de cantidad ("15", "12.5", "1,500.25") -> centésimas (entero).
 * null si es inválido (negativos, >2 decimales, texto, vacío).
 */
export function parseQtyToCent(input: string): number | null {
  return parseDecimalToHundredths(input);
}
