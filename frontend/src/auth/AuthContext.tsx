/**
 * AuthContext.tsx — Sesión del agente.
 *
 * - Access token SOLO en memoria; refresh token en localStorage
 *   (`ma_refresh_token`), con rotación en cada refresh.
 * - Al montar: si hay refresh token guardado → POST /auth/refresh silencioso
 *   → GET /agents/me → `authenticated`; si algo falla → `anonymous` limpio.
 * - Refresh proactivo ~60s antes de expirar el access token (decodifica el
 *   `exp` del JWT; fallback a `access_expires_at` del par).
 * - Registra en el cliente HTTP el getter del token
 *   (`setAuthTokenProvider`) y el handler de refresh tras 401
 *   (`setAuthRefreshHandler`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  api,
  ApiError,
  setAuthRefreshHandler,
  setAuthTokenProvider,
} from "../api/client";
import type {
  AgentRole,
  RegisterAgentResponse,
  RequestedCapacity,
  SelfState,
  TokenPair,
} from "../api/types";

const REFRESH_TOKEN_KEY = "ma_refresh_token";
/** Margen: refrescar el access token ~60s ANTES de que expire. */
const REFRESH_MARGIN_MS = 60_000;
/** Nunca programar el refresh proactivo a menos de 5s vista. */
const MIN_REFRESH_DELAY_MS = 5_000;
/** Reintento del refresh proactivo tras un fallo transitorio (red). */
const RETRY_REFRESH_DELAY_MS = 30_000;

export type AuthStatus = "loading" | "anonymous" | "authenticated";

export interface RegisterParams {
  username: string;
  password: string;
  role: AgentRole;
  /** Opcional: capacidades solicitadas al registrarse (openapi). */
  requested_capacities?: RequestedCapacity[];
}

export interface AuthContextValue {
  status: AuthStatus;
  agent: SelfState | null;
  login(username: string, password: string): Promise<void>;
  register(params: RegisterParams): Promise<void>;
  logout(): Promise<void>;
  /** Re-consulta GET /agents/me y actualiza `agent`. */
  refreshSelf(): Promise<void>;
  /** Access token vigente (solo en memoria) o null. */
  accessToken: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function readStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredRefreshToken(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(REFRESH_TOKEN_KEY);
    else localStorage.setItem(REFRESH_TOKEN_KEY, value);
  } catch {
    // Almacenamiento no disponible: la sesión vivirá solo en memoria.
  }
}

/** `exp` del payload del JWT en milisegundos epoch, o null si no se puede decodificar. */
function decodeJwtExpMs(token: string): number | null {
  const payloadPart = token.split(".")[1];
  if (payloadPart === undefined || payloadPart === "") return null;
  try {
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (payload !== null && typeof payload === "object" && "exp" in payload) {
      const exp: unknown = (payload as Record<string, unknown>)["exp"];
      if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [agent, setAgent] = useState<SelfState | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Fuente de verdad síncrona del access token (el estado es para re-render).
  const accessTokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef<Promise<boolean> | null>(null);
  const refreshTickRef = useRef<() => void>(() => {});
  const bootstrappedRef = useRef(false);

  // Registro idempotente: el cliente HTTP lee SIEMPRE el token vigente
  // del ref (en memoria), incluso desde peticiones ya en curso.
  setAuthTokenProvider(() => accessTokenRef.current);

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const scheduleProactiveRefresh = useCallback(
    (pair: TokenPair) => {
      clearRefreshTimer();
      const expMs =
        decodeJwtExpMs(pair.access_token) ?? Date.parse(pair.access_expires_at);
      if (!Number.isFinite(expMs)) return;
      const delay = Math.max(
        MIN_REFRESH_DELAY_MS,
        expMs - Date.now() - REFRESH_MARGIN_MS,
      );
      refreshTimerRef.current = setTimeout(() => refreshTickRef.current(), delay);
    },
    [clearRefreshTimer],
  );

  /** Guarda el par nuevo: access en memoria, refresh (rotado) en localStorage. */
  const applyTokens = useCallback(
    (pair: TokenPair) => {
      accessTokenRef.current = pair.access_token;
      setAccessToken(pair.access_token);
      writeStoredRefreshToken(pair.refresh_token);
      scheduleProactiveRefresh(pair);
    },
    [scheduleProactiveRefresh],
  );

  /** Vuelve a `anonymous` limpio: sin tokens, sin agente, sin timers. */
  const clearSession = useCallback(() => {
    clearRefreshTimer();
    accessTokenRef.current = null;
    setAccessToken(null);
    setAgent(null);
    writeStoredRefreshToken(null);
    setStatus("anonymous");
  }, [clearRefreshTimer]);

  /**
   * Intercambia el refresh token guardado por un par nuevo (rotación).
   * Single-flight: llamadas concurrentes (timer proactivo + 401 del cliente)
   * comparten una sola petición. Si el servidor lo rechaza con 401/403 la
   * sesión está muerta → `anonymous` limpio.
   */
  const performRefresh = useCallback((): Promise<boolean> => {
    if (refreshInFlightRef.current !== null) return refreshInFlightRef.current;
    const stored = readStoredRefreshToken();
    if (stored === null) return Promise.resolve(false);
    const flight = (async () => {
      try {
        const pair = await api.post<TokenPair>(
          "/auth/refresh",
          { refresh_token: stored },
          { auth: false },
        );
        applyTokens(pair);
        return true;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          clearSession();
        }
        return false;
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = flight;
    return flight;
  }, [applyTokens, clearSession]);

  // Tick del refresh proactivo; si falla por causa transitoria (red)
  // reintenta en 30s mientras siga habiendo refresh token guardado.
  useEffect(() => {
    refreshTickRef.current = () => {
      void performRefresh().then((ok) => {
        if (!ok && readStoredRefreshToken() !== null) {
          clearRefreshTimer();
          refreshTimerRef.current = setTimeout(
            () => refreshTickRef.current(),
            RETRY_REFRESH_DELAY_MS,
          );
        }
      });
    };
  }, [performRefresh, clearRefreshTimer]);

  // Handler que el cliente HTTP ejecuta ante un 401 (retry-tras-refresh).
  useEffect(() => {
    setAuthRefreshHandler(performRefresh);
    return () => {
      setAuthRefreshHandler(null);
    };
  }, [performRefresh]);

  // Arranque: reconexión silenciosa con el refresh token persistido.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void (async () => {
      const stored = readStoredRefreshToken();
      if (stored === null) {
        setStatus("anonymous");
        return;
      }
      try {
        const pair = await api.post<TokenPair>(
          "/auth/refresh",
          { refresh_token: stored },
          { auth: false },
        );
        applyTokens(pair);
        const snapshot = await api.get<SelfState>("/agents/me");
        setAgent(snapshot);
        setStatus("authenticated");
      } catch {
        clearSession();
      }
    })();
  }, [applyTokens, clearSession]);

  // Limpieza del timer al desmontar el provider.
  useEffect(() => {
    return () => {
      clearRefreshTimer();
    };
  }, [clearRefreshTimer]);

  const refreshSelf = useCallback(async () => {
    const snapshot = await api.get<SelfState>("/agents/me");
    setAgent(snapshot);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const pair = await api.post<TokenPair>(
        "/auth/login",
        { username, password },
        { auth: false },
      );
      applyTokens(pair);
      const snapshot = await api.get<SelfState>("/agents/me");
      setAgent(snapshot);
      setStatus("authenticated");
    },
    [applyTokens],
  );

  const register = useCallback(
    async (params: RegisterParams) => {
      // El registro devuelve el par de tokens + snapshot inicial del agente.
      const res = await api.post<RegisterAgentResponse>(
        "/auth/register",
        params,
        { auth: false },
      );
      applyTokens(res);
      setAgent(res.agent);
      setStatus("authenticated");
    },
    [applyTokens],
  );

  const logout = useCallback(async () => {
    const stored = readStoredRefreshToken();
    if (stored !== null) {
      try {
        // Revocación best-effort; la sesión local se limpia igualmente.
        await api.post<undefined>("/auth/logout", { refresh_token: stored });
      } catch {
        // Ignorado: sin red o token ya revocado.
      }
    }
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, agent, login, register, logout, refreshSelf, accessToken }),
    [status, agent, login, register, logout, refreshSelf, accessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  }
  return ctx;
}
