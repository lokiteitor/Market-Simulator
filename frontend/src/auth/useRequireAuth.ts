/**
 * useRequireAuth.ts — Guardia de rutas protegidas.
 *
 * Redirige a /auth cuando la sesión es `anonymous`. Mientras la sesión está
 * en `loading` (refresh silencioso al montar) no redirige: la página puede
 * mostrar skeletons hasta que se resuelva.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router";

import { useAuth, type AuthContextValue } from "./AuthContext";

export function useRequireAuth(): AuthContextValue {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.status === "anonymous") {
      navigate("/auth", { replace: true });
    }
  }, [auth.status, navigate]);

  return auth;
}
