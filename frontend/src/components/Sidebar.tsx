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
  IconBank,
  IconBoxes,
  IconCatalog,
  IconCity,
  IconCoin,
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
  { to: "/inventory", label: "Inventario", icon: IconBoxes },
  { to: "/orders", label: "Órdenes", icon: IconOrders },
  { to: "/transformations", label: "Transformaciones", icon: IconTransformations },
  { to: "/installations", label: "Instalaciones", icon: IconFactory },
  { to: "/bank", label: "Banco", icon: IconBank },
  { to: "/history", label: "Historial", icon: IconHistory },
  { to: "/profile", label: "Perfil", icon: IconUser },
];

// Navegación del panel admin. El admin es además la cuenta personal del
// operador humano: ve AMBAS secciones (monitoreo + mercado).
const ADMIN_NAV: ReadonlyArray<NavItem> = [
  { to: "/admin", label: "Resumen", icon: IconShield, end: true },
  { to: "/admin/agents", label: "Agentes", icon: IconUsers },
  { to: "/admin/cities", label: "Ciudades", icon: IconCity },
  { to: "/admin/market", label: "Mercado", icon: IconMarket },
  { to: "/admin/production", label: "Producción", icon: IconFactory },
  { to: "/admin/bank", label: "Moneda", icon: IconCoin },
];

function NavList({ items }: { items: ReadonlyArray<NavItem> }) {
  return (
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
  );
}

export function Sidebar() {
  const { agent } = useAuth();
  const isAdmin = agent?.agent.role === "admin";

  return (
    <nav className={styles.sidebar} aria-label="Navegación principal">
      <div className={styles.brand}>
        <span className={styles.brandIcon}>
          <IconSprout size={22} />
        </span>
        <span className={styles.brandText}>Mercado Agrícola</span>
      </div>

      {isAdmin ? (
        <>
          <p className={styles.sectionLabel}>Monitoreo</p>
          <NavList items={ADMIN_NAV} />
          <p className={styles.sectionLabel}>Mercado</p>
          <NavList items={MARKET_NAV} />
        </>
      ) : (
        <NavList items={MARKET_NAV} />
      )}
    </nav>
  );
}
