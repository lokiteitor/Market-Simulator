/**
 * ProfilePage — /profile (protegida) [FE4].
 *
 * - Identidad del agente: username, Badge de rol (color de tokens), estado,
 *   ID (CopyId) y fecha de registro.
 * - Capital: disponible / reservado / total (StatCards, fmtMoney).
 *   Nota: el openapi no expone el capital semilla original; se muestran los
 *   valores actuales con la explicación de cómo se asignó la semilla.
 * - Capacidades productivas: tabla receta (nombre + CopyId) e installations
 *   (en curso / libres), con nombres resueltos del catálogo.
 * - Sesión: estado del canal WS (useNotifications) y logout con Modal de
 *   confirmación.
 * - Si el agente está en quiebra: ErrorBanner permanente.
 *
 * Datos: query ["self"] → GET /agents/me (misma clave que invalida el WS),
 * con fallback al snapshot del AuthContext mientras carga.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  InstallationStatus,
  Product,
  Recipe,
  SelfState,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  CopyId,
  DataTable,
  EmptyState,
  ErrorBanner,
  Modal,
  Skeleton,
  StatCard,
  type DataTableColumn,
} from "../../components";
import { useNotifications } from "../../ws/NotificationsProvider";
import { fmtDateTime, fmtMoney, fmtQty, fmtRelative, truncId } from "../../lib/format";
import { ROLE_LABEL } from "../auth/roles";
import styles from "./ProfilePage.module.css";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const BANKRUPT_PROBLEM = {
  title: "Agente en quiebra",
  detail:
    "Este agente está en quiebra: las operaciones de escritura (órdenes y " +
    "transformaciones) quedan bloqueadas de forma permanente. La consulta " +
    "de datos sigue disponible.",
} as const;

export default function ProfilePage() {
  const { status, agent: sessionAgent, logout } = useAuth();
  const { connected } = useNotifications();
  const navigate = useNavigate();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const authenticated = status === "authenticated";

  const selfQ = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
    enabled: authenticated,
  });

  const recipesQ = useQuery({
    queryKey: ["catalog", "recipes"],
    queryFn: ({ signal }) =>
      api.get<Recipe[]>("/catalog/recipes", { signal, auth: false }),
    staleTime: 5 * 60_000,
  });

  const productsQ = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: 5 * 60_000,
  });

  const snapshot: SelfState | null = selfQ.data ?? sessionAgent;

  const recipesById = useMemo(() => {
    const map = new Map<string, Recipe>();
    for (const r of recipesQ.data ?? []) map.set(r.recipe_id, r);
    return map;
  }, [recipesQ.data]);

  const productsById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQ.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQ.data]);

  const installationColumns = useMemo<Array<DataTableColumn<InstallationStatus>>>(
    () => [
      { key: "name", header: "Instalación" },
      {
        key: "installation_type",
        header: "Tipo",
        render: (i) => <span className="mono">{i.installation_type}</span>,
      },
      {
        key: "level",
        header: "Nivel",
        align: "right",
        mono: true,
        render: (i) => `${i.level} ${i.unit_label}`,
      },
      { key: "running", header: "En curso", align: "right", mono: true },
      {
        key: "available_slots",
        header: "Libres",
        align: "right",
        mono: true,
        render: (i) => i.available_slots ?? Math.max(0, i.level - i.running),
      },
      {
        key: "next_upgrade_price_cents",
        header: "Mejora",
        align: "right",
        mono: true,
        render: (i) =>
          i.next_upgrade_price_cents === null
            ? "—"
            : fmtMoney(i.next_upgrade_price_cents),
      },
    ],
    [],
  );

  // Quiebra: por estado del snapshot o por 403 del endpoint (agent_bankrupt).
  const bankrupt =
    snapshot?.agent.status === "bankrupt" ||
    (selfQ.error instanceof ApiError && selfQ.error.status === 403);

  const confirmLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      navigate("/auth", { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  const loadError =
    snapshot === null && selfQ.error instanceof ApiError && !bankrupt
      ? selfQ.error.problem
      : null;

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Perfil</h1>
        <p className={styles.pageSubtitle}>
          Identidad, capital y capacidades productivas de tu agente.
        </p>
      </header>

      {bankrupt && <ErrorBanner problem={BANKRUPT_PROBLEM} />}

      {snapshot === null ? (
        loadError !== null ? (
          <div className={styles.loadError}>
            <ErrorBanner problem={loadError} />
            <button
              type="button"
              className={styles.btnGhost}
              onClick={() => void selfQ.refetch()}
            >
              Reintentar
            </button>
          </div>
        ) : (
          <div className={styles.cardBox} aria-busy="true">
            <Skeleton rows={6} />
          </div>
        )
      ) : (
        <>
          <div className={styles.topGrid}>
            {/* ---- Identidad -------------------------------------------- */}
            <section
              className={styles.cardBox}
              aria-labelledby="perfil-identidad"
            >
              <h2 id="perfil-identidad" className={styles.sectionTitle}>
                Identidad
              </h2>
              <div className={styles.identityHead}>
                <span
                  className={cx(
                    styles.avatar,
                    {
                      transformer: styles.avatarTransformer,
                      trader: styles.avatarTrader,
                      admin: undefined,
                      bank: undefined,
                      city: undefined,
                    }[snapshot.agent.role],
                  )}
                  aria-hidden="true"
                >
                  {snapshot.agent.username.slice(0, 1).toUpperCase()}
                </span>
                <div className={styles.identityMain}>
                  <p className={styles.username}>{snapshot.agent.username}</p>
                  <div className={styles.badges}>
                    <Badge kind={snapshot.agent.role}>
                      {ROLE_LABEL[snapshot.agent.role]}
                    </Badge>
                    <Badge
                      kind={
                        snapshot.agent.status === "active"
                          ? "active"
                          : "bankrupt"
                      }
                    >
                      {snapshot.agent.status === "active"
                        ? "Activo"
                        : "En quiebra"}
                    </Badge>
                  </div>
                </div>
              </div>
              <dl className={styles.meta}>
                <div className={styles.metaRow}>
                  <dt>ID de agente</dt>
                  <dd>
                    <CopyId id={snapshot.agent.agent_id} />
                  </dd>
                </div>
                <div className={styles.metaRow}>
                  <dt>Registro</dt>
                  <dd>
                    {fmtDateTime(snapshot.agent.registered_at)}{" "}
                    <span className={styles.mutedInline}>
                      ({fmtRelative(snapshot.agent.registered_at)})
                    </span>
                  </dd>
                </div>
                {snapshot.agent.bankrupt_at != null && (
                  <div className={styles.metaRow}>
                    <dt>Quiebra</dt>
                    <dd>{fmtDateTime(snapshot.agent.bankrupt_at)}</dd>
                  </div>
                )}
              </dl>
            </section>

            {/* ---- Sesión ------------------------------------------------ */}
            <section className={styles.cardBox} aria-labelledby="perfil-sesion">
              <h2 id="perfil-sesion" className={styles.sectionTitle}>
                Sesión
              </h2>
              <div className={styles.wsRow} role="status" aria-live="polite">
                <span
                  className={cx(
                    styles.wsDot,
                    connected ? styles.wsOn : styles.wsOff,
                  )}
                  aria-hidden="true"
                />
                <span>
                  Notificaciones en tiempo real:{" "}
                  <strong>{connected ? "conectadas" : "sin conexión"}</strong>
                </span>
              </div>
              <p className={styles.wsHint}>
                {connected
                  ? "Recibirás ejecuciones de órdenes, expiraciones y fin de procesos al instante."
                  : "Reintentando conexión automáticamente; el estado se resincroniza al reconectar."}
              </p>
              <div className={styles.sessionActions}>
                <button
                  type="button"
                  className={styles.btnDanger}
                  onClick={() => setConfirmOpen(true)}
                >
                  Cerrar sesión
                </button>
              </div>
            </section>
          </div>

          {/* ---- Capital ------------------------------------------------- */}
          <section aria-labelledby="perfil-capital" className={styles.section}>
            <h2 id="perfil-capital" className={styles.sectionTitle}>
              Capital
            </h2>
            <div className={styles.stats}>
              <StatCard
                label="Capital disponible"
                value={fmtMoney(snapshot.capital_available_cents)}
                hint="Libre para órdenes de compra y salarios de procesos."
              />
              <StatCard
                label="Capital reservado"
                value={fmtMoney(snapshot.capital_reserved_cents)}
                hint="Retenido por tus órdenes de compra activas."
              />
              <StatCard
                label="Capital total"
                value={fmtMoney(
                  snapshot.capital_available_cents +
                    snapshot.capital_reserved_cents,
                )}
                hint="La semilla inicial fue el promedio del capital de los agentes activos al registrarte."
              />
            </div>
          </section>

          {/* ---- Instalaciones ------------------------------------------- */}
          <section
            aria-labelledby="perfil-instalaciones"
            className={styles.section}
          >
            <h2 id="perfil-instalaciones" className={styles.sectionTitle}>
              Instalaciones compradas
            </h2>
            <p className={styles.sectionSubtitle}>
              Lugares productivos comprados y su nivel (presupuesto de procesos
              paralelos compartido por las recetas del tipo).
            </p>
            <DataTable
              columns={installationColumns}
              rows={snapshot.installations}
              rowKey={(i) => i.installation_type}
              caption="Instalaciones compradas del agente"
              empty={
                <EmptyState
                  title="Sin instalaciones"
                  hint="Este agente aún no ha comprado instalaciones; sin ellas no puede producir."
                />
              }
            />
          </section>
        </>
      )}

      {/* ---- Confirmación de logout ------------------------------------- */}
      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!loggingOut) setConfirmOpen(false);
        }}
        title="Cerrar sesión"
      >
        <p className={styles.modalText}>
          Se revocará tu sesión en este dispositivo. Tu agente, sus órdenes
          activas y sus procesos en curso siguen viviendo en el servidor; podrás
          volver a entrar con tu usuario y contraseña.
        </p>
        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.btnGhost}
            onClick={() => setConfirmOpen(false)}
            disabled={loggingOut}
          >
            Cancelar
          </button>
          <button
            type="button"
            className={styles.btnDanger}
            onClick={() => void confirmLogout()}
            disabled={loggingOut}
          >
            {loggingOut ? "Cerrando…" : "Cerrar sesión"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
