/**
 * Header — barra superior del layout protegido.
 *
 * - Indicador de conexión WS: usa la prop `connected` si viene; si no, lee
 *   el ConnectionContext (default: desconectado).
 * - Campana con badge: cuenta las notificaciones (`ma:toast`) recibidas desde
 *   el montaje; el botón limpia el contador.
 * - Slot de usuario (`user`): por defecto, enlace a /profile.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { useConnection } from "./ConnectionContext";
import { IconBell, IconUser } from "./icons";
import styles from "./Header.module.css";

export interface HeaderProps {
  /** Estado de la conexión WS; si se omite se lee del ConnectionContext. */
  connected?: boolean;
  /** Slot de usuario (nombre/rol/menú). Default: enlace a /profile. */
  user?: ReactNode;
}

export function Header({ connected, user }: HeaderProps) {
  const ctx = useConnection();
  const isConnected = connected ?? ctx.connected;
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const onToast = () => setUnread((n) => n + 1);
    window.addEventListener("ma:toast", onToast);
    return () => window.removeEventListener("ma:toast", onToast);
  }, []);

  return (
    <header className={styles.header}>
      <div
        className={isConnected ? styles.conn : `${styles.conn} ${styles.connOff}`}
        role="status"
        aria-live="polite"
      >
        <span className={styles.connDot} aria-hidden="true" />
        <span className={styles.connText}>
          {isConnected ? "Conectado" : "Sin conexión"}
        </span>
      </div>

      <div className={styles.spacer} />

      <button
        type="button"
        className={styles.bell}
        aria-label={
          unread > 0
            ? `Notificaciones: ${unread} nuevas. Marcar como vistas`
            : "Notificaciones: sin novedades"
        }
        onClick={() => setUnread(0)}
      >
        <IconBell size={20} />
        {unread > 0 && (
          <span className={styles.bellBadge} aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      <div className={styles.user}>
        {user ?? (
          <Link to="/profile" className={styles.userLink}>
            <IconUser size={18} />
            <span>Mi perfil</span>
          </Link>
        )}
      </div>
    </header>
  );
}
