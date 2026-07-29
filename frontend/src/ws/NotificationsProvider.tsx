/**
 * NotificationsProvider.tsx — Canal WebSocket de notificaciones push.
 *
 * - Conecta cuando hay access token: `VITE_API_BASE_URL` transformada
 *   (http→ws, https→wss; `/v1` → `/v1/ws?token=<access>`).
 * - Reconexión con backoff exponencial 1s→30s; al RE-conectar resincroniza
 *   el estado (`queryClient.invalidateQueries()`), porque pudieron perderse
 *   notificaciones durante la desconexión.
 * - Por cada Notification: toast global vía `CustomEvent("ma:toast")` (el
 *   host <Toast/> lo escucha) + invalidación de queries por tipo según un
 *   mapa explícito (["self"], ["orders"], ["market", productId],
 *   ["processes"], ["history"]).
 * - Excepción de ruido: los fills propios (`order_executed`) NO emiten un
 *   toast cada uno; se acumulan en una ventana (fillDigest.ts) y se anuncian
 *   juntos. Las invalidaciones sí son inmediatas, así que las tablas se
 *   actualizan al instante.
 * - Cierre limpio (sin reintentos fantasma) al perder la autenticación o
 *   desmontar. Único mensaje cliente→servidor: `subscribe_products` en cada
 *   onopen (el tape `trade_printed` es por suscripción; la SPA usa `"*"`).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { API_BASE_URL } from "../api/client";
import { ConnectionContext } from "../components/ConnectionContext";
import type { Notification, NotificationType, Product } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtMoney } from "../lib/format";
import {
  addFill,
  digestToast,
  emptyDigest,
  FILL_DIGEST_WINDOW_MS,
  type FillDigest,
} from "./fillDigest";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// Toasts (evento global "ma:toast" que consume <Toast/> de FE3)
// ---------------------------------------------------------------------------

export type ToastKind = "success" | "info" | "warning" | "error";

export interface ToastDetail {
  kind: ToastKind;
  title: string;
  body?: string;
}

/** Emite un toast global. Útil también desde páginas (éxito/error de forms). */
export function emitToast(detail: ToastDetail): void {
  window.dispatchEvent(new CustomEvent<ToastDetail>("ma:toast", { detail }));
}

// ---------------------------------------------------------------------------
// Helpers de payload (libre por tipo; acceso defensivo)
// ---------------------------------------------------------------------------

function strField(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" ? v : null;
}

function numField(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Valida y normaliza un frame del WS al sobre `Notification`. */
function parseNotification(raw: string): Notification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type !== "string") return null;
  const occurredAt = obj["occurred_at"];
  const payload = obj["payload"];
  return {
    type: type as NotificationType,
    occurred_at:
      typeof occurredAt === "string" ? occurredAt : new Date().toISOString(),
    payload:
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

// ---------------------------------------------------------------------------
// Notification → toast
// ---------------------------------------------------------------------------

function toastForNotification(
  msg: Notification,
  productName: (productId: string) => string | null,
): ToastDetail | null {
  const p = msg.payload;
  switch (msg.type) {
    case "order_executed":
      // Fills propios: llegan en ráfaga con el mercado activo, así que no se
      // anuncian uno a uno. El toast lo emite el digest (fillDigest.ts) al
      // cerrar su ventana; aquí solo se invalidan queries.
      return null;
    case "order_expired":
      return {
        kind: "warning",
        title: "Orden expirada",
        body: "Una de tus órdenes expiró; sus reservas quedaron liberadas.",
      };
    case "order_cancelled":
      return {
        kind: "info",
        title: "Orden cancelada",
        body: "La orden fue cancelada y sus reservas liberadas.",
      };
    case "transformation_completed":
      return {
        kind: "success",
        title: "Transformación completada",
        body: "El lote producido ya está disponible en tu inventario.",
      };
    case "bankruptcy_notice":
      return {
        kind: "error",
        title: "Tu agente está en quiebra",
        body: "Las operaciones de escritura quedan bloqueadas.",
      };
    case "agent_bankrupt": {
      const username = strField(p, "username");
      const detail: ToastDetail = {
        kind: "warning",
        title: "Un agente quebró",
      };
      if (username !== null) detail.body = `${username} salió del mercado.`;
      return detail;
    }
    case "trade_printed":
      // Tape de mercado: demasiado frecuente para toasts; solo invalida queries.
      return null;
    case "gold_converted": {
      const direction = strField(p, "direction");
      const total = numField(p, "total_cents");
      const body =
        total !== null
          ? direction === "sell_gold"
            ? `Vendiste oro al banco por ${fmtMoney(total)} (dinero acuñado).`
            : `Compraste oro al banco por ${fmtMoney(total)}.`
          : "Conversión ejecutada en la ventanilla del banco.";
      return { kind: "success", title: "Conversión de oro", body };
    }
    case "city_income": {
      const amount = numField(p, "amount_cents");
      return {
        kind: "success",
        title: "Ingreso urbano",
        body:
          amount !== null
            ? `Recibiste ${fmtMoney(amount)} del flujo circular de ingreso.`
            : "Tu ciudad recibió su reparto de ingreso urbano.",
      };
    }
    case "installation_purchased":
      // La pestaña que ejecuta la compra ya emite su propio toast de éxito;
      // este evento solo sirve para sincronizar otras pestañas (invalida self).
      return null;
    case "deposit_depleted": {
      const productId = strField(p, "product_id");
      const name = productId !== null ? productName(productId) : null;
      return {
        kind: "warning",
        title: "Yacimiento agotado",
        body:
          name !== null
            ? `El yacimiento de ${name} llegó a 0: su receta ya no produce nada.`
            : "Un recurso no renovable se agotó: su receta ya no produce nada.",
      };
    }
    default:
      // Tipo desconocido (p. ej. heartbeat de aplicación): sin toast.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Notification → invalidación de queries (mapa explícito por tipo)
// ---------------------------------------------------------------------------

type QueryDomain =
  | "self"
  | "orders"
  | "market"
  | "processes"
  | "history"
  | "bank"
  | "deposits";

const INVALIDATIONS: Record<NotificationType, readonly QueryDomain[]> = {
  order_executed: ["self", "orders", "market", "history"],
  order_expired: ["self", "orders", "market"],
  order_cancelled: ["self", "orders", "market"],
  transformation_completed: ["self", "processes", "history"],
  bankruptcy_notice: ["self", "orders", "processes"],
  agent_bankrupt: ["market"],
  trade_printed: ["market"],
  gold_converted: ["self", "history", "bank"],
  city_income: ["self", "history"],
  installation_purchased: ["self"],
  // "market" acotado al product_id del payload: el agotamiento cambia la
  // economía del producto (precios/plan de los que lo miran en /market).
  deposit_depleted: ["deposits", "market", "history"],
  // El consumo urbano DESTRUYE inventario de la ciudad (ADR-029): cambia su
  // snapshot. No lleva product_id en la raíz del payload (es una lista), así que
  // no se acota por producto.
  city_consumed: ["self", "history"],
  city_population_changed: ["self", "history"],
};

/** Dominio → queryKey; `deposits` vive bajo el prefijo del catálogo. */
const DOMAIN_KEY: Record<QueryDomain, readonly unknown[]> = {
  self: ["self"],
  orders: ["orders"],
  market: ["market"],
  processes: ["processes"],
  history: ["history"],
  bank: ["bank"],
  deposits: ["catalog", "deposits"],
};

function invalidateForNotification(qc: QueryClient, msg: Notification): void {
  const domains: readonly QueryDomain[] =
    (INVALIDATIONS as Record<string, readonly QueryDomain[] | undefined>)[
      msg.type
    ] ?? [];
  const productId = strField(msg.payload, "product_id");
  for (const domain of domains) {
    if (domain === "market" && productId !== null) {
      // Acotada al producto afectado; prefix-match de react-query.
      void qc.invalidateQueries({ queryKey: ["market", productId] });
    } else {
      void qc.invalidateQueries({ queryKey: DOMAIN_KEY[domain] });
    }
  }
}

// ---------------------------------------------------------------------------
// URL del WS
// ---------------------------------------------------------------------------

/** `http://host/v1` → `ws://host/v1/ws?token=…` (https → wss). */
function buildWsUrl(accessToken: string): string {
  const wsBase = API_BASE_URL.replace(/^http/i, "ws");
  return `${wsBase}/ws?token=${encodeURIComponent(accessToken)}`;
}

// ---------------------------------------------------------------------------
// Provider + hook
// ---------------------------------------------------------------------------

interface NotificationsValue {
  connected: boolean;
}

const NotificationsContext = createContext<NotificationsValue>({
  connected: false,
});

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { accessToken } = useAuth();
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  // Digest de fills: los `order_executed` no emiten toast uno a uno (con bots
  // operando llegan en ráfaga), se acumulan y se anuncian juntos al cerrar la
  // ventana. Las invalidaciones NO se agrupan: siguen siendo inmediatas.
  const fillDigestRef = useRef<FillDigest>(emptyDigest());
  const fillTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Último token vigente: las RE-conexiones usan siempre el más reciente
  // sin reiniciar el socket en cada rotación proactiva del access token.
  const tokenRef = useRef<string | null>(accessToken);
  tokenRef.current = accessToken;

  const hasToken = accessToken !== null;

  useEffect(() => {
    if (!hasToken) {
      setConnected(false);
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    /** Vuelca el digest acumulado (si hay algo) y cierra la ventana. */
    const flushFillDigest = () => {
      if (fillTimerRef.current !== null) {
        clearTimeout(fillTimerRef.current);
        fillTimerRef.current = null;
      }
      const toast = digestToast(fillDigestRef.current);
      fillDigestRef.current = emptyDigest();
      if (toast !== null) emitToast(toast);
    };

    /** Acumula un fill y programa el volcado si la ventana no estaba abierta. */
    const pushFill = (payload: Record<string, unknown>) => {
      fillDigestRef.current = addFill(fillDigestRef.current, payload);
      if (fillTimerRef.current === null) {
        fillTimerRef.current = setTimeout(flushFillDigest, FILL_DIGEST_WINDOW_MS);
      }
    };

    let attempts = 0; // reintentos consecutivos fallidos
    let wasConnected = false; // ya hubo conexión en esta sesión de efecto

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** attempts);
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      const token = tokenRef.current;
      if (disposed || token === null) return;

      let ws: WebSocket;
      try {
        ws = new WebSocket(buildWsUrl(token));
      } catch {
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempts = 0;
        // Tape por suscripción (fan-out selectivo, contrato §12): sin esta
        // declaración el servidor no entrega trade_printed. La SPA usa el
        // comodín (pocas conexiones, y las páginas de mercado invalidan
        // queries por producto); debe re-enviarse en cada (re)conexión.
        try {
          ws.send(JSON.stringify({ type: "subscribe_products", product_ids: ["*"] }));
        } catch {
          // Socket cerrado entre onopen y send: la reconexión lo reintenta.
        }
        setConnected(true);
        if (wasConnected) {
          // Resync tras reconexión: el estado autoritativo pudo cambiar
          // mientras estábamos desconectados.
          void queryClient.invalidateQueries();
        }
        wasConnected = true;
      };

      ws.onmessage = (event: MessageEvent) => {
        if (disposed || typeof event.data !== "string") return;
        const msg = parseNotification(event.data);
        if (msg === null) return;
        // Resolver de nombres best-effort desde la caché del catálogo (si
        // alguna página ya lo cargó); sin fetch propio en el hot path del WS.
        const products = queryClient.getQueryData<Product[]>([
          "catalog",
          "products",
        ]);
        const productName = (productId: string): string | null =>
          products?.find((p) => p.product_id === productId)?.name ?? null;
        if (msg.type === "order_executed") {
          // Agregado en ventana; el resto del pipeline sigue igual.
          pushFill(msg.payload);
        } else {
          const toast = toastForNotification(msg, productName);
          if (toast !== null) emitToast(toast);
        }
        invalidateForNotification(queryClient, msg);
      };

      ws.onclose = () => {
        if (disposed) return;
        socket = null;
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        // `onclose` llega después y programa el reintento.
      };
    };

    connect();

    return () => {
      // Cierre limpio al perder auth o desmontar: sin reintentos fantasma.
      disposed = true;
      // Los fills pendientes se anuncian ahora: mejor un toast tardío que
      // perder la señal (y así no queda un timer huérfano).
      flushFillDigest();
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (socket !== null) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close(1000, "cierre del cliente");
        } catch {
          // Ya cerrado.
        }
      }
      setConnected(false);
    };
  }, [hasToken, queryClient]);

  const value = useMemo<NotificationsValue>(() => ({ connected }), [connected]);

  // FIX B1 (indicador WS): el estado REAL del socket vive aquí, pero el Header
  // pinta el indicador leyendo ConnectionContext (capa de presentación), que
  // antes NADIE proveía (default {connected:false}) → punto siempre rojo.
  // Solución elegida (puente, sin acoplar el Header al feature WS): este único
  // proveedor refleja `connected` también en ConnectionContext. Así el Header
  // sigue desacoplado de este módulo y el indicador muestra el estado real
  // ("Conectado"/"Sin conexión") en TODAS las páginas protegidas, que cuelgan
  // de este subárbol. `value` ({ connected }) satisface ambos contextos.
  return (
    <NotificationsContext.Provider value={value}>
      <ConnectionContext.Provider value={value}>
        {children}
      </ConnectionContext.Provider>
    </NotificationsContext.Provider>
  );
}

/** Estado del canal WS (indicador de conexión del Header). */
export function useNotifications(): { connected: boolean } {
  return useContext(NotificationsContext);
}
