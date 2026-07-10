/**
 * useRequireRole.ts — Guardia de rutas por rol (encima de useRequireAuth).
 *
 * Redirige a `/dashboard` si la sesión está autenticada pero el rol del agente
 * no está en `allowed`. Mientras `loading` no redirige (aún no se conoce el
 * rol). La redirección a /auth de los anónimos la sigue haciendo useRequireAuth.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router";

import type { AgentRole } from "../api/types";
import { useAuth, type AuthContextValue } from "./AuthContext";

export function useRequireRole(...allowed: AgentRole[]): AuthContextValue {
  const auth = useAuth();
  const navigate = useNavigate();

  const role = auth.agent?.agent.role ?? null;

  useEffect(() => {
    if (auth.status === "authenticated" && role !== null && !allowed.includes(role)) {
      navigate("/dashboard", { replace: true });
    }
    // `allowed` es un array nuevo por render; se compara por su contenido serializado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, role, navigate, allowed.join(",")]);

  return auth;
}
