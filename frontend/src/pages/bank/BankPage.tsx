/**
 * BankPage — banco central y ventanilla de convertibilidad (patrón oro).
 *
 * Datos:
 * - ["bank"] → GET /bank (política monetaria y ventanilla). Refetch cada 5 s:
 *   las conversiones de OTROS agentes no se difunden por WS, solo la propia
 *   (`gold_converted`, que además invalida esta query).
 * - ["self"] → GET /agents/me (oro y capital propios, quiebra).
 * - ["catalog", "products"] → nombre/unidad del producto-respaldo (oro).
 *
 * Acciones:
 * - POST /bank/convert (sell_gold acuña dinero; buy_gold lo destruye).
 *   Validación client-side en bankMath.ts; el servidor es autoritativo.
 *
 * Un GET /bank con 409 `no_gold_standard` significa que la corrida no tiene
 * banco central sembrado → EmptyState (la entrada del menú es fija).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  BankInfo,
  ConversionDirection,
  ConvertRequest,
  GoldConversion,
  Problem,
  Product,
  SelfState,
} from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import {
  EmptyState,
  ErrorBanner,
  Field,
  Skeleton,
  StatCard,
  showToast,
} from "../../components";
import { fmtBps, fmtMoney, fmtQty, parseQtyToCent } from "../../lib/format";
import {
  DIRECTION_LABEL,
  conversionPriceCents,
  conversionTotalCents,
  validateConversion,
} from "./bankMath";
import styles from "./BankPage.module.css";

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

const DIRECTIONS: readonly ConversionDirection[] = ["sell_gold", "buy_gold"];

export default function BankPage() {
  const queryClient = useQueryClient();
  const { status } = useAuth();
  const authenticated = status === "authenticated";

  const bankQuery = useQuery({
    queryKey: ["bank"],
    queryFn: ({ signal }) => api.get<BankInfo>("/bank", { signal }),
    enabled: authenticated,
    refetchInterval: 5_000,
    // 409 no_gold_standard es un estado terminal de la corrida, no un fallo
    // transitorio: reintentarlo solo repetiría el mismo resultado.
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 409) && failureCount < 3,
  });
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
    enabled: authenticated,
  });
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const bank = bankQuery.data ?? null;
  const self = selfQuery.data ?? null;

  const gold = useMemo<Product | null>(() => {
    if (bank === null || productsQuery.data === undefined) return null;
    return (
      productsQuery.data.find((p) => p.product_id === bank.product_id) ?? null
    );
  }, [bank, productsQuery.data]);
  const goldUnit = gold?.unit ?? "oz";

  const bankrupt = self !== null && self.agent.status === "bankrupt";
  // El contrato devuelve 403 para admin y bank (no operan la ventanilla).
  const nonOperator =
    self !== null && (self.agent.role === "admin" || self.agent.role === "bank");
  const capital = self?.capital_available_cents ?? 0;
  const goldAvailable = useMemo(() => {
    if (self === null || bank === null) return 0;
    return (
      self.inventory.find((p) => p.product_id === bank.product_id)
        ?.qty_available_cent ?? 0
    );
  }, [self, bank]);

  // ---- Formulario de conversión ---------------------------------------------
  const [direction, setDirection] = useState<ConversionDirection>("sell_gold");
  const [qtyText, setQtyText] = useState("");

  const qtyCent = parseQtyToCent(qtyText);
  const price = bank !== null ? conversionPriceCents(bank, direction) : null;
  const totalCents =
    qtyCent !== null && price !== null
      ? conversionTotalCents(qtyCent, price)
      : null;
  // Solo validamos cuando hay algo tecleado: sin ruido en el estado inicial.
  const validationError =
    bank !== null && price !== null && qtyText.trim() !== ""
      ? qtyCent === null
        ? "Cantidad inválida: usa un decimal positivo con hasta 2 decimales."
        : validateConversion({
            direction,
            qtyCent,
            priceCentsPerUnit: price,
            goldAvailableCent: goldAvailable,
            capitalAvailableCents: capital,
            bankGoldAvailableCent: bank.bank_gold_available_cent,
          })
      : null;

  const convert = useMutation({
    mutationFn: (req: ConvertRequest) =>
      api.post<GoldConversion>("/bank/convert", req),
    onSuccess: (resp) => {
      showToast({
        kind: "success",
        title:
          resp.direction === "sell_gold" ? "Oro vendido" : "Oro comprado",
        body: `${fmtQty(resp.qty_cent, goldUnit)} por ${fmtMoney(resp.total_cents)}.`,
      });
      setQtyText("");
      void queryClient.invalidateQueries({ queryKey: ["self"] });
      void queryClient.invalidateQueries({ queryKey: ["bank"] });
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (qtyCent === null || validationError !== null || bank === null) return;
    convert.mutate({ direction, qty_cent: qtyCent });
  };

  const canSubmit =
    qtyCent !== null &&
    validationError === null &&
    bank !== null &&
    !convert.isPending &&
    !bankrupt &&
    !nonOperator;

  // ---- Render -----------------------------------------------------------------
  const noGoldStandard =
    bankQuery.isError &&
    bankQuery.error instanceof ApiError &&
    bankQuery.error.status === 409;
  const loadError =
    bankQuery.isError && !noGoldStandard
      ? toProblem(bankQuery.error)
      : selfQuery.isError
        ? toProblem(selfQuery.error)
        : null;
  const loading = bankQuery.isPending || selfQuery.isPending;

  return (
    <div className={styles["page"]}>
      <div className={styles["pageHead"]}>
        <h1 className={styles["title"]}>Banco central</h1>
        <p className={styles["subtitle"]}>
          Patrón oro: todo el dinero nuevo nace respaldado por oro en la
          ventanilla de convertibilidad
        </p>
      </div>

      {noGoldStandard ? (
        <EmptyState
          title="Sin patrón oro"
          hint="Esta corrida no tiene banco central sembrado: la ventanilla de convertibilidad no está disponible."
        />
      ) : loadError !== null ? (
        <ErrorBanner problem={loadError} />
      ) : loading || bank === null ? (
        <Skeleton rows={4} />
      ) : (
        <>
          {/* ---- Política monetaria ------------------------------------------ */}
          <section
            className={styles["panel"]}
            aria-labelledby="bank-policy"
          >
            <div className={styles["panelHead"]}>
              <h2 id="bank-policy" className={styles["panelTitle"]}>
                Política monetaria
              </h2>
              <p className={styles["panelHint"]}>
                Se actualiza cada 5 segundos con el estado autoritativo del
                servidor
              </p>
            </div>
            <div className={styles["statGrid"]}>
              <StatCard
                label="Paridad"
                value={fmtMoney(bank.parity_cents_per_unit)}
                hint={`por ${goldUnit} de ${gold?.name ?? "oro"}`}
              />
              <StatCard
                label="Ventanilla compra (bid)"
                value={fmtMoney(bank.window_bid_cents)}
                hint="el banco te compra oro: acuña dinero"
              />
              <StatCard
                label="Ventanilla venta (ask)"
                value={fmtMoney(bank.window_ask_cents)}
                hint="el banco te vende oro: destruye dinero"
              />
              <StatCard
                label="Cobertura"
                value={fmtBps(bank.coverage_ratio_bps)}
                hint="respaldo exigido sobre la emisión"
              />
              <StatCard
                label="Dinero emitido"
                value={fmtMoney(bank.money_issued_cents)}
                hint={`destruido: ${fmtMoney(bank.money_burned_cents)}`}
              />
              <StatCard
                label="Capacidad de emisión"
                value={fmtMoney(bank.issuance_capacity_cents)}
                hint="máximo respaldado por el oro actual del banco"
              />
              <StatCard
                label="Oro del banco"
                value={fmtQty(bank.bank_gold_available_cent, goldUnit)}
                hint={`capital: ${fmtMoney(bank.bank_capital_available_cents)}`}
              />
              <StatCard
                label="Yacimiento de oro"
                value={
                  bank.deposit_remaining_cent !== null
                    ? fmtQty(bank.deposit_remaining_cent, goldUnit)
                    : "—"
                }
                hint="oro minable restante (ADR-023)"
              />
            </div>
          </section>

          {/* ---- Ventanilla --------------------------------------------------- */}
          <section
            className={styles["panel"]}
            aria-labelledby="bank-window"
          >
            <div className={styles["panelHead"]}>
              <h2 id="bank-window" className={styles["panelTitle"]}>
                Ventanilla de convertibilidad
              </h2>
              <p className={styles["panelHint"]}>
                Sin fees: vender oro acuña dinero nuevo; comprarlo destruye el
                dinero pagado
              </p>
            </div>

            <p className={styles["position"]}>
              Tu posición:{" "}
              <span className={styles["mono"]}>
                {fmtQty(goldAvailable, goldUnit)}
              </span>{" "}
              de {gold?.name ?? "oro"} ·{" "}
              <span className={styles["mono"]}>{fmtMoney(capital)}</span>{" "}
              disponibles
            </p>

            {bankrupt && (
              <ErrorBanner
                problem={{
                  title: "Agente en quiebra",
                  detail:
                    "Este agente salió del mercado: las operaciones de escritura están deshabilitadas.",
                }}
              />
            )}
            {nonOperator && (
              <p className={styles["subtle"]}>
                Los roles administrador y banco central no operan la
                ventanilla (solo monitoreo).
              </p>
            )}

            <form className={styles["form"]} onSubmit={submit}>
              <fieldset
                className={styles["directions"]}
                disabled={bankrupt || nonOperator || convert.isPending}
              >
                <legend className={styles["srOnly"]}>
                  Dirección de la conversión
                </legend>
                {DIRECTIONS.map((d) => (
                  <label
                    key={d}
                    className={cx(
                      styles["direction"],
                      direction === d ? styles["directionActive"] : undefined,
                    )}
                  >
                    <input
                      type="radio"
                      name="direction"
                      value={d}
                      checked={direction === d}
                      onChange={() => setDirection(d)}
                      className={styles["srOnly"]}
                    />
                    <span>{DIRECTION_LABEL[d]}</span>
                    {bank !== null && (
                      <span className={styles["directionPrice"]}>
                        {fmtMoney(conversionPriceCents(bank, d))} / {goldUnit}
                      </span>
                    )}
                  </label>
                ))}
              </fieldset>

              <div className={styles["formRow"]}>
                <Field
                  label={`Cantidad de oro (${goldUnit})`}
                  error={validationError}
                >
                  <input
                    type="text"
                    inputMode="decimal"
                    value={qtyText}
                    onChange={(e) => setQtyText(e.target.value)}
                    placeholder="0.00"
                    disabled={bankrupt || nonOperator || convert.isPending}
                  />
                </Field>

                <dl className={styles["preview"]}>
                  <dt>Precio aplicado</dt>
                  <dd className={styles["mono"]}>
                    {price !== null ? `${fmtMoney(price)} / ${goldUnit}` : "—"}
                  </dd>
                  <dt>{direction === "sell_gold" ? "Recibirás" : "Pagarás"}</dt>
                  <dd className={styles["mono"]}>
                    {totalCents !== null ? fmtMoney(totalCents) : "—"}
                  </dd>
                </dl>
              </div>

              {convert.isError && (
                <ErrorBanner problem={toProblem(convert.error)} />
              )}

              <div className={styles["formActions"]}>
                <button
                  type="submit"
                  className={cx(styles["btn"], styles["btnPrimary"])}
                  disabled={!canSubmit}
                >
                  {convert.isPending
                    ? "Convirtiendo…"
                    : direction === "sell_gold"
                      ? "Vender oro"
                      : "Comprar oro"}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
