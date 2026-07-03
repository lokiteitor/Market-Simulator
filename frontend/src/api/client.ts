/**
 * client.ts — Cliente HTTP del API REST (detrás de APISIX).
 *
 * - Base URL de `import.meta.env.VITE_API_BASE_URL` (default
 *   `http://localhost:9080/v1`).
 * - Inyecta `Authorization: Bearer <access>` leyendo el token vigente del
 *   getter registrado por AuthContext vía `setAuthTokenProvider(fn)`.
 * - Ante un 401 en rutas autenticadas intenta UN refresh (delegado al
 *   handler registrado por AuthContext vía `setAuthRefreshHandler(fn)`,
 *   con single-flight) y reintenta la petición UNA sola vez.
 * - Los errores llegan como `ApiError` con el `Problem` RFC 7807
 *   (application/problem+json) parseado, incluida la extensión `errors[]`.
 */

import type { Problem } from "./types";

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

const envBase: unknown = import.meta.env.VITE_API_BASE_URL;

/**
 * Base URL del API sin slash final (ej. "http://localhost:9080/v1").
 * También la usa el WS de notificaciones para derivar `ws://…/v1/ws`.
 */
export const API_BASE_URL: string = (
  typeof envBase === "string" && envBase.trim() !== ""
    ? envBase.trim()
    : "http://localhost:9080/v1"
).replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Error tipado (RFC 7807)
// ---------------------------------------------------------------------------

/** Error del API: envuelve el `Problem` (problem+json) de la respuesta. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }
}

// ---------------------------------------------------------------------------
// Integración con AuthContext (token en memoria + refresh tras 401)
// ---------------------------------------------------------------------------

export type AuthTokenProvider = () => string | null;

/**
 * Handler de refresh registrado por AuthContext: intercambia el refresh
 * token por un par nuevo y devuelve `true` si tras ejecutarlo el token
 * provider ya entrega un access token válido.
 */
export type AuthRefreshHandler = () => Promise<boolean>;

let tokenProvider: AuthTokenProvider | null = null;
let refreshHandler: AuthRefreshHandler | null = null;
let refreshInFlight: Promise<boolean> | null = null;

/** Registra el getter del access token vigente (AuthContext lo mantiene en memoria). */
export function setAuthTokenProvider(fn: AuthTokenProvider | null): void {
  tokenProvider = fn;
}

/** Registra el callback de refresh que se ejecuta ante un 401. */
export function setAuthRefreshHandler(fn: AuthRefreshHandler | null): void {
  refreshHandler = fn;
}

/** Ejecuta el refresh con single-flight: N peticiones con 401 → 1 refresh. */
function runRefresh(): Promise<boolean> {
  const handler = refreshHandler;
  if (handler === null) return Promise.resolve(false);
  if (refreshInFlight === null) {
    refreshInFlight = (async () => {
      try {
        return await handler();
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// Núcleo de peticiones
// ---------------------------------------------------------------------------

export interface ApiRequestOptions {
  /** Señal de cancelación (react-query la provee en `queryFn`). */
  signal?: AbortSignal;
  /** Cabeceras extra. */
  headers?: Record<string, string>;
  /**
   * Si es `false`, no adjunta `Authorization` ni intenta refresh ante 401
   * (para endpoints públicos: login, register, refresh, catálogo).
   */
  auth?: boolean;
}

function doFetch(
  method: string,
  path: string,
  body: unknown,
  opts: ApiRequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json, application/problem+json",
    ...opts.headers,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.auth !== false) {
    const token = tokenProvider?.() ?? null;
    if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (opts.signal !== undefined) init.signal = opts.signal;
  return fetch(`${API_BASE_URL}${path}`, init);
}

/** Extrae un `Problem` de una respuesta de error (con fallback sintético). */
async function parseProblem(res: Response): Promise<Problem> {
  const fallback: Problem = {
    type: "about:blank",
    title: res.statusText !== "" ? res.statusText : `HTTP ${res.status}`,
    status: res.status,
  };
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return fallback;
  try {
    const data: unknown = await res.json();
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return fallback;
    }
    const problem = { ...fallback, ...(data as Partial<Problem>) };
    if (typeof problem.status !== "number") problem.status = res.status;
    return problem;
  } catch {
    return fallback;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: ApiRequestOptions = {},
): Promise<T> {
  let res = await doFetch(method, path, body, opts);

  // 401 → UN intento de refresh y UN reintento. Nunca para /auth/* (evita
  // bucles: un 401 de login/refresh es definitivo).
  if (res.status === 401 && opts.auth !== false && !path.startsWith("/auth/")) {
    const refreshed = await runRefresh();
    if (refreshed) res = await doFetch(method, path, body, opts);
  }

  if (!res.ok) throw new ApiError(await parseProblem(res));

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === "") return undefined as T;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface ApiClient {
  get<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T>;
  del<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
}

export const api: ApiClient = {
  get<T>(path: string, opts?: ApiRequestOptions): Promise<T> {
    return request<T>("GET", path, undefined, opts);
  },
  post<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T> {
    return request<T>("POST", path, body, opts);
  },
  del<T>(path: string, opts?: ApiRequestOptions): Promise<T> {
    return request<T>("DELETE", path, undefined, opts);
  },
};
