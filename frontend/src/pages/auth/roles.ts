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
    role: "primary_producer",
    label: "Productor primario",
    description:
      "Produce materias primas desde cero (cultivos, ordeña) y las vende en el mercado.",
  },
  {
    role: "transformer",
    label: "Transformador",
    description:
      "Convierte insumos en productos elaborados mediante recetas (molienda, panadería…).",
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
  primary_producer: "Productor primario",
  transformer: "Transformador",
  consumer: "Consumidor",
  trader: "Trader",
  // Rol de solo-monitoreo; no aparece en el selector de registro (ROLE_INFOS).
  admin: "Administrador",
};
