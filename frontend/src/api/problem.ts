/**
 * Conversión de errores desconocidos a Problem RFC 7807 mostrable en
 * ErrorBanner. Único punto compartido: antes estaba copiado en cada página.
 */
import { ApiError } from "./client";
import type { Problem } from "./types";

export function toProblem(err: unknown): Problem {
  if (err instanceof ApiError) return err.problem;
  return {
    type: "about:blank",
    title: "Error de comunicación",
    status: 0,
    detail: err instanceof Error ? err.message : "Fallo de red desconocido.",
  };
}
