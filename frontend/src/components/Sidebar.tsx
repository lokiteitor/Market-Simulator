/**
 * Sidebar — navegación lateral con iconos SVG propios + texto.
 * NavLink marca la ruta activa (aria-current="page" automático).
 * En pantallas estrechas colapsa a solo iconos (los textos quedan
 * accesibles vía visually-hidden).
 */
import type { ComponentType } from "react";
import { NavLink } from "react-router";

import { useAuth } from "../auth/AuthContext";
import {
  IconCatalog,
  IconDashboard,
  IconFactory,
  IconHistory,
  IconMarket,
  IconOrders,
  IconShield,
  IconSprout,
  IconTransformations,
  IconUser,
  IconUsers,
  type IconProps,
} from "./icons";
import styles from "./Sidebar.module.css";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<IconProps>;
  /** `end` en NavLink: sólo activo en coincidencia exacta (rutas índice). */
  end?: boolean;
}

const MARKET_NAV: ReadonlyArray<NavItem> = [
  { to: "/dashboard", label: "Dashboard", icon: IconDashboard },
  { to: "/market", label: "Mercado", icon: IconMarket },
  { to: "/catalog", label: "Catálogo", icon: IconCatalog },
  { to: "/orders", label: "Órdenes", icon: IconOrders },
  { to: "/transformations", label: "Transformaciones", icon: IconTransformations },
  { to: "/history", label: "Historial", icon: IconHistory },
  { to: "/profile", label: "Perfil", icon: IconUser },
];

// Navegación del rol admin (solo-monitoreo): reemplaza a la de mercado.
const ADMIN_NAV: ReadonlyArray<NavItem> = [
  { to: "/admin", label: "Resumen", icon: IconShield, end: true },
  { to: "/admin/agents", label: "Agentes", icon: IconUsers },
  { to: "/admin/market", label: "Mercado", icon: IconMarket },
  { to: "/admin/production", label: "Producción", icon: IconFactory },
];

export function Sidebar() {
  const { agent } = useAuth();
  const isAdmin = agent?.agent.role === "admin";
  const items = isAdmin ? ADMIN_NAV : MARKET_NAV;

  return (
    <nav className={styles.sidebar} aria-label="Navegación principal">
      <div className={styles.brand}>
        <span className={styles.brandIcon}>
          <IconSprout size={22} />
        </span>
        <span className={styles.brandText}>Mercado Agrícola</span>
      </div>

      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                isActive ? `${styles.link} ${styles.linkActive}` : styles.link
              }
              title={item.label}
            >
              <span className={styles.linkIcon}>
                <item.icon size={20} />
              </span>
              <span className={styles.linkText}>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
