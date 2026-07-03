/**
 * Layout — armazón común de las rutas protegidas:
 * Sidebar (izquierda) + Header (indicador WS, campana, usuario) + contenido.
 * Monta también el host global de toasts (<Toast/>), de modo que cualquier
 * página protegida recibe las notificaciones `ma:toast`.
 */
import type { ReactNode } from "react";

import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { Toast } from "./Toast";
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
      <Toast />
    </div>
  );
}
