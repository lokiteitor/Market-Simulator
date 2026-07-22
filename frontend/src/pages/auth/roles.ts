/**
 * roles.ts — Metadatos de presentación de los roles de agente [FE4].
 *
 * Los COLORES de rol viven exclusivamente en tokens.css
 * (--color-role-* / --color-role-*-soft); aquí solo etiquetas y
 * descripciones en español para el selector de registro y el perfil.
 */
import type { AgentRole } from "../../api/types";

export interface RoleInfo {
  role: AgentRole;
  label: string;
  description: string;
}

/** Orden de presentación fijo del selector de rol. */
export const ROLE_INFOS: readonly RoleInfo[] = [
  {
    role: "transformer",
    label: "Transformador",
    description:
      "Único rol productivo: extrae (pozos, minas, campos) y transforma insumos en productos elaborados mediante recetas.",
  },
  {
    role: "consumer",
    label: "Consumidor",
    description:
      "Compra productos finales para consumirlos; representa la demanda del mercado.",
  },
  {
    role: "trader",
    label: "Trader",
    description:
      "Compra y vende cualquier producto buscando margen; aporta liquidez al mercado.",
  },
];

/** Etiqueta humana por rol (para Badges y textos). */
export const ROLE_LABEL: Record<AgentRole, string> = {
  transformer: "Transformador",
  consumer: "Consumidor",
  trader: "Trader",
  // Rol de solo-monitoreo; no aparece en el selector de registro (ROLE_INFOS).
  admin: "Administrador",
  // Banco central del patrón oro; tampoco es registrable.
  bank: "Banco central",
  // Ciudad-consumidor (ADR-020): sembrada y operada por bots; no registrable.
  city: "Ciudad",
};
