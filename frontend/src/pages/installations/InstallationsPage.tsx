/**
 * InstallationsPage — compra y mejora de instalaciones (ADR-021).
 *
 * Datos:
 * - ["self"] → GET /agents/me (instalaciones compradas, capital, quiebra).
 * - ["catalog", "installation-types"] → GET /catalog/installation-types
 *   (catálogo completo; se filtra por el rol del agente).
 *
 * Acciones:
 * - Comprar (nivel 0→1) o mejorar (+1) → POST /agents/me/installations con
 *   `expected_current_level` (concurrencia optimista: un 409 significa que el
 *   nivel cambió por debajo — se resincroniza ["self"] sin cobrar).
 *
 * El precio mostrado es autoritativo: `base_price_cents` para la 1ª compra
 * (floor(base×(growth/10000)^0) = base) y `next_upgrade_price_cents` del
 * servidor para mejoras (null ⇒ nivel máximo alcanzado).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  AcquireInstallationRequest,
  AcquireInstallationResponse,
  InstallationStatus,
  InstallationType,
  Problem,
  SelfState,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  Modal,
  ProgressBar,
  Skeleton,
  showToast,
} from "../../components";
import { fmtMoney } from "../../lib/format";
import styles from "./InstallationsPage.module.css";

/** Error desconocido → Problem RFC 7807 mostrable en ErrorBanner. */
function toProblem(err: unknown): Problem {
  if (err instanceof ApiError) return err.problem;
  return {
    type: "about:blank",
    title: "Error de comunicación",
    status: 0,
    detail: err instanceof Error ? err.message : "Fallo de red desconocido.",
  };
}

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** Tipo del catálogo + estado comprado (si existe), listo para la tarjeta. */
interface InstallationRow {
  type: InstallationType;
  owned: InstallationStatus | null;
}

/** Precio de la siguiente acción sobre el tipo, o null si nivel máximo. */
function nextPriceCents(row: InstallationRow): number | null {
  if (row.owned === null) return row.type.base_price_cents;
  return row.owned.next_upgrade_price_cents;
}

export default function InstallationsPage() {
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const authenticated = status === "authenticated";

  // Guard `enabled: authenticated`: ver nota en TransformationsPage (evita un
  // 401 en carrera con el refresh del bootstrap).
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
    enabled: authenticated,
  });
  const typesQuery = useQuery({
    queryKey: ["catalog", "installation-types"],
    queryFn: ({ signal }) =>
      api.get<InstallationType[]>("/catalog/installation-types", {
        signal,
        auth: false,
      }),
    staleTime: Infinity,
  });

  const self = selfQuery.data ?? null;
  const bankrupt = self !== null && self.agent.status === "bankrupt";
  const capital = self?.capital_available_cents ?? 0;

  // Tipos del rol del agente, con su instalación comprada (si la hay).
  // Los no comprados van al final; dentro de cada grupo, por precio ascendente.
  const rows = useMemo<InstallationRow[]>(() => {
    if (self === null || typesQuery.data === undefined) return [];
    const ownedByKey = new Map<string, InstallationStatus>();
    for (const i of self.installations) ownedByKey.set(i.installation_type, i);
    return typesQuery.data
      .filter((t) => t.role === self.agent.role)
      .map((t) => ({ type: t, owned: ownedByKey.get(t.key) ?? null }))
      .sort((a, b) => {
        if ((a.owned === null) !== (b.owned === null)) {
          return a.owned === null ? 1 : -1;
        }
        return a.type.base_price_cents - b.type.base_price_cents;
      });
  }, [self, typesQuery.data]);

  // ---- Compra/mejora ------------------------------------------------------------
  const [rowToBuy, setRowToBuy] = useState<InstallationRow | null>(null);

  const acquire = useMutation({
    mutationFn: (req: AcquireInstallationRequest) =>
      api.post<AcquireInstallationResponse>("/agents/me/installations", req),
    onSuccess: (resp) => {
      showToast({
        kind: "success",
        title: resp.level === 1 ? "Instalación comprada" : "Instalación mejorada",
        body: `${resp.name} al nivel ${resp.level} por ${fmtMoney(resp.amount_charged_cents)}.`,
      });
      setRowToBuy(null);
      void queryClient.invalidateQueries({ queryKey: ["self"] });
    },
    onError: (err) => {
      // 409: el nivel cambió por debajo (otro cliente/bot) → resincronizar.
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ["self"] });
      }
    },
  });

  const openBuy = (row: InstallationRow) => {
    acquire.reset();
    setRowToBuy(row);
  };

  const confirmBuy = () => {
    if (rowToBuy === null) return;
    acquire.mutate({
      installation_type: rowToBuy.type.key,
      expected_current_level: rowToBuy.owned?.level ?? 0,
    });
  };

  const buyPrice = rowToBuy !== null ? nextPriceCents(rowToBuy) : null;

  // ---- Render ---------------------------------------------------------------------
  const loading = selfQuery.isPending || typesQuery.isPending;
  const loadError = selfQuery.isError
    ? toProblem(selfQuery.error)
    : typesQuery.isError
      ? toProblem(typesQuery.error)
      : null;

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Instalaciones</h1>
        {self !== null && (
          <p className={styles["capital"]}>
            Capital disponible:{" "}
            <span className={styles["mono"]}>{fmtMoney(capital)}</span>
          </p>
        )}
      </div>

      {bankrupt && (
        <ErrorBanner
          problem={{
            title: "Agente en quiebra",
            detail:
              "Este agente salió del mercado: las operaciones de escritura están deshabilitadas.",
          }}
        />
      )}

      <section className={styles["panel"]} aria-labelledby="inst-buy">
        <div className={styles["panelHead"]}>
          <h2 id="inst-buy" className={styles["panelTitle"]}>
            Instalaciones de tu rol
          </h2>
          <p className={styles["panelHint"]}>
            El nivel es el nº de procesos simultáneos compartido por las recetas
            del tipo; cada mejora suma un hueco
          </p>
        </div>

        {loadError !== null ? (
          <ErrorBanner problem={loadError} />
        ) : loading ? (
          <Skeleton rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Tu rol no requiere instalaciones"
            hint="Solo los roles productivos (productor primario y transformador) compran instalaciones para ejecutar recetas."
          />
        ) : (
          <div className={styles["grid"]}>
            {rows.map((row) => {
              const price = nextPriceCents(row);
              const maxed = row.owned !== null && price === null;
              const affordable = price !== null && price <= capital;
              return (
                <div key={row.type.key} className={styles["card"]}>
                  <div className={styles["cardHead"]}>
                    <span className={styles["cardName"]}>{row.type.name}</span>
                    {row.owned === null ? (
                      <Badge kind="neutral">No comprada</Badge>
                    ) : maxed ? (
                      <Badge kind="completed">Nivel máximo</Badge>
                    ) : (
                      <Badge kind="active">Nivel {row.owned.level}</Badge>
                    )}
                  </div>

                  {row.owned !== null ? (
                    <>
                      <ProgressBar
                        value={row.owned.running}
                        max={row.owned.level}
                        label={`${row.owned.running}/${row.owned.level} en uso`}
                      />
                      <p className={styles["cardMeta"]}>
                        {row.owned.level} {row.type.unit_label} · máx.{" "}
                        {row.type.max_level}
                      </p>
                    </>
                  ) : (
                    <p className={styles["cardMeta"]}>
                      Sin esta instalación no puedes ejecutar sus recetas
                      (ADR-021). Unidad: {row.type.unit_label} · máx.{" "}
                      {row.type.max_level}
                    </p>
                  )}

                  <div className={styles["cardFoot"]}>
                    {maxed ? (
                      <span className={styles["subtle"]}>
                        Sin más mejoras disponibles
                      </span>
                    ) : (
                      <>
                        <span className={styles["price"]}>
                          {fmtMoney(price ?? 0)}
                        </span>
                        <button
                          type="button"
                          className={cx(styles["btn"], styles["btnPrimary"])}
                          onClick={() => openBuy(row)}
                          disabled={bankrupt || !affordable}
                          title={
                            affordable
                              ? undefined
                              : "Capital disponible insuficiente"
                          }
                        >
                          {row.owned === null ? "Comprar" : "Mejorar"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Modal: confirmar compra/mejora */}
      <Modal
        open={rowToBuy !== null}
        onClose={() => {
          if (!acquire.isPending) setRowToBuy(null);
        }}
        title={rowToBuy?.owned === null ? "Comprar instalación" : "Mejorar instalación"}
      >
        {rowToBuy !== null && (
          <div className={styles["modalBody"]}>
            <dl className={styles["detailList"]}>
              <dt>Instalación</dt>
              <dd>{rowToBuy.type.name}</dd>
              <dt>Nivel</dt>
              <dd className={styles["mono"]}>
                {rowToBuy.owned?.level ?? 0} → {(rowToBuy.owned?.level ?? 0) + 1}
              </dd>
              <dt>Precio</dt>
              <dd className={styles["mono"]}>
                {buyPrice !== null ? fmtMoney(buyPrice) : "—"}
              </dd>
              <dt>Capital tras la compra</dt>
              <dd className={styles["mono"]}>
                {buyPrice !== null ? fmtMoney(capital - buyPrice) : "—"}
              </dd>
            </dl>
            <p className={styles["subtle"]}>
              El pago se acredita al banco central; la compra no es reversible y
              no hay reventa de instalaciones.
            </p>
            {acquire.isError && (
              <ErrorBanner problem={toProblem(acquire.error)} />
            )}
            <div className={styles["modalActions"]}>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnSecondary"])}
                onClick={() => setRowToBuy(null)}
                disabled={acquire.isPending}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={cx(styles["btn"], styles["btnPrimary"])}
                onClick={confirmBuy}
                disabled={acquire.isPending || bankrupt}
              >
                {acquire.isPending
                  ? "Comprando…"
                  : rowToBuy.owned === null
                    ? "Confirmar compra"
                    : "Confirmar mejora"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
