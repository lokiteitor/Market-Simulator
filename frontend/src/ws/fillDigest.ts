/**
 * fillDigest.ts — agregación de los fills propios (`order_executed`) para no
 * ahogar la UI en toasts.
 *
 * Con bots operando, cada agente recibe fills en ráfaga: un toast por evento
 * es ruido puro (por eso el tape público `trade_printed` ya estaba silenciado).
 * En vez de perder la señal, se acumulan en una ventana de 10 s y se emite un
 * único toast con el resumen. Las invalidaciones de queries NO pasan por aquí:
 * siguen siendo inmediatas, así que las tablas se actualizan al instante.
 *
 * Módulo puro (sin timers ni React): el temporizador lo gestiona el proveedor.
 */
import { fmtMoney, fmtQty } from "../lib/format";

/** Ventana de agregación de fills, en milisegundos reales. */
export const FILL_DIGEST_WINDOW_MS = 10_000;

export interface FillDigest {
  /** Número de fills acumulados en la ventana. */
  count: number;
  /** Cantidad ejecutada acumulada, en centésimas de unidad. */
  qtyCent: number;
  /** Nocional acumulado en centavos. */
  notionalCents: number;
}

/**
 * Forma del toast resultante. Estructural a propósito: encaja tanto con el
 * `ToastDetail` del host <Toast/> como con el del proveedor WS.
 */
export interface FillToast {
  kind: "success";
  title: string;
  body: string;
}

export function emptyDigest(): FillDigest {
  return { count: 0, qtyCent: 0, notionalCents: 0 };
}

function numField(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Acumula un fill. Los campos ausentes o no numéricos solo incrementan el
 * contador (el toast degrada a "N órdenes ejecutadas" sin cifras).
 *
 * Nocional = floor(qty × precio / 100): misma aritmética entera que
 * `notionalCents` del backend (cantidad en centésimas × precio en centavos).
 */
export function addFill(
  digest: FillDigest,
  payload: Record<string, unknown>,
): FillDigest {
  const qty = numField(payload, "qty_executed_cent") ?? numField(payload, "qty_cent");
  const price = numField(payload, "price_cents");
  return {
    count: digest.count + 1,
    qtyCent: digest.qtyCent + (qty ?? 0),
    notionalCents:
      digest.notionalCents +
      (qty !== null && price !== null ? Math.floor((qty * price) / 100) : 0),
  };
}

/**
 * Convierte el acumulado en toast. Con un solo fill conserva el detalle
 * (cantidad y precio efectivo); con varios, el resumen de la ventana.
 * Devuelve null si no hay nada que anunciar.
 */
export function digestToast(digest: FillDigest): FillToast | null {
  if (digest.count === 0) return null;

  if (digest.count === 1) {
    const body =
      digest.qtyCent > 0
        ? `Ejecutado: ${fmtQty(digest.qtyCent)} por ${fmtMoney(digest.notionalCents)}.`
        : "Una de tus órdenes se ejecutó.";
    return { kind: "success", title: "Orden ejecutada", body };
  }

  const detail =
    digest.qtyCent > 0
      ? `${fmtQty(digest.qtyCent)} por ${fmtMoney(digest.notionalCents)} en los últimos ${Math.round(FILL_DIGEST_WINDOW_MS / 1000)} s.`
      : `En los últimos ${Math.round(FILL_DIGEST_WINDOW_MS / 1000)} s.`;

  return {
    kind: "success",
    title: `${digest.count} ejecuciones de tus órdenes`,
    body: detail,
  };
}
