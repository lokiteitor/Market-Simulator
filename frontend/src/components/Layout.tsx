/**
 * Layout — armazón común de las rutas protegidas:
 * Sidebar (izquierda) + Header (indicador WS, campana, usuario) + contenido.
 *
 * El host global de toasts (<Toast/>) se monta UNA sola vez en main.tsx
 * (cubre también /auth). No lo montamos aquí para no duplicar cada notificación
 * `ma:toast` (FIX B2: ambos hosts escuchaban el mismo evento global).
 */
import type { ReactNode } from "react";

import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import styles from "./Layout.module.css";

export interface LayoutProps {
  children: ReactNode;
  /** Estado WS explícito; si se omite, Header lee el ConnectionContext. */
  connected?: boolean;
  /** Slot de usuario del Header. */
  user?: ReactNode;
}

export function Layout({ children, connected, user }: LayoutProps) {
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#contenido">
        Saltar al contenido
      </a>
      <Sidebar />
      <div className={styles.column}>
        <Header connected={connected} user={user} />
        <main id="contenido" className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
