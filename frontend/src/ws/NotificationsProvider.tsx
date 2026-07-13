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
 * - Cierre limpio (sin reintentos fantasma) al perder la autenticación o
 *   desmontar. El canal es unidireccional servidor→cliente.
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
import type { Notification, NotificationType } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { fmtMoney, fmtQty } from "../lib/format";

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

function toastForNotification(msg: Notification): ToastDetail | null {
  const p = msg.payload;
  switch (msg.type) {
    case "order_executed": {
      const qty = numField(p, "qty_executed_cent") ?? numField(p, "qty_cent");
      const price = numField(p, "price_cents");
      const body =
        qty !== null && price !== null
          ? `Ejecutado: ${fmtQty(qty)} a ${fmtMoney(price)}.`
          : "Una de tus órdenes se ejecutó.";
      return { kind: "success", title: "Orden ejecutada", body };
    }
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
    default:
      // Tipo desconocido (p. ej. heartbeat de aplicación): sin toast.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Notification → invalidación de queries (mapa explícito por tipo)
// ---------------------------------------------------------------------------

type QueryDomain = "self" | "orders" | "market" | "processes" | "history";

const INVALIDATIONS: Record<NotificationType, readonly QueryDomain[]> = {
  order_executed: ["self", "orders", "market", "history"],
  order_expired: ["self", "orders", "market"],
  order_cancelled: ["self", "orders", "market"],
  transformation_completed: ["self", "processes", "history"],
  bankruptcy_notice: ["self", "orders", "processes"],
  agent_bankrupt: ["market"],
  trade_printed: ["market"],
  gold_converted: ["self", "history"],
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
      void qc.invalidateQueries({ queryKey: [domain] });
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
        const toast = toastForNotification(msg);
        if (toast !== null) emitToast(toast);
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
