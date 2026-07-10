/**
 * icons.tsx — Set de iconos inline SVG propios (sin CDNs ni dependencias).
 * Trazos con `currentColor` para heredar el color del contexto; decorativos
 * por defecto (aria-hidden): el texto accesible lo pone el componente que
 * los usa.
 */
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  /** Lado en px del icono (cuadrado). Default 20. */
  size?: number;
}

function Base({
  size = 20,
  children,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Brote — marca de la app. */
export function IconSprout(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 21v-8" />
      <path d="M12 13c0-3-2.4-4.8-5.8-4.8 0 3.4 2.4 4.8 5.8 4.8Z" />
      <path d="M12 10.5c0-3.6 2.6-6 6.8-6 0 4.4-3 6-6.8 6Z" />
    </Base>
  );
}

/** Velocímetro — Dashboard. */
export function IconDashboard(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 14.5 15.5 11" />
      <path d="M20.2 16.5a9 9 0 1 0-16.4 0" />
    </Base>
  );
}

/** Tendencia — Mercado. */
export function IconMarket(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </Base>
  );
}

/** Libro abierto — Catálogo. */
export function IconCatalog(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 4.5H9a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3H2.5Z" />
      <path d="M21.5 4.5H15a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h6.5Z" />
    </Base>
  );
}

/** Portapapeles — Órdenes. */
export function IconOrders(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4a3 3 0 0 1 6 0" />
      <path d="M9 11h6" />
      <path d="M9 15h6" />
    </Base>
  );
}

/** Fábrica — Transformaciones. */
export function IconTransformations(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 21V4h5v9l5-4v4l5-4v12Z" />
      <path d="M7 17h2" />
      <path d="M12 17h2" />
    </Base>
  );
}

/** Reloj — Historial. */
export function IconHistory(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Base>
  );
}

/** Persona — Perfil / slot de usuario. */
export function IconUser(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </Base>
  );
}

/** Campana — notificaciones. */
export function IconBell(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4.6 1.8 5.8 1.8 5.8H4.2S6 14.1 6 9.5" />
      <path d="M10 19.3a2.1 2.1 0 0 0 4 0" />
    </Base>
  );
}

/** Copiar (dos hojas). */
export function IconCopy(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Base>
  );
}

/** Check. */
export function IconCheck(props: IconProps) {
  return (
    <Base {...props}>
      <polyline points="4 12.5 10 18.5 20 6.5" />
    </Base>
  );
}

/** Cerrar (X). */
export function IconClose(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </Base>
  );
}

/** Triángulo de alerta. */
export function IconAlert(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3.5 2.5 20h19Z" />
      <path d="M12 9.5V14" />
      <path d="M12 17.2v.1" />
    </Base>
  );
}

/** Información (círculo con i). */
export function IconInfo(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.8v.1" />
    </Base>
  );
}

/** Bandeja vacía — EmptyState. */
export function IconInbox(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.6 5.5h14.8L22 13v5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18v-5Z" />
      <path d="M2 13h6l1.8 3h4.4L16 13h6" />
    </Base>
  );
}

/** Escudo — sección de administración/monitoreo. */
export function IconShield(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3 5 6v5c0 4.4 3 8 7 10 4-2 7-5.6 7-10V6l-7-3Z" />
      <path d="m9.2 12 1.9 1.9 3.7-3.9" />
    </Base>
  );
}

/** Grupo de personas — agentes/bots. */
export function IconUsers(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.9" />
      <path d="M17 14.2A5.5 5.5 0 0 1 20.5 19" />
    </Base>
  );
}

/** Fábrica — producción/transformaciones globales. */
export function IconFactory(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 20V10l5 3V10l5 3V10l5 3v7Z" />
      <path d="M3 20h18" />
      <path d="M6 4h2l.5 6" />
    </Base>
  );
}
