/**
 * QuickOrderForm [FE6] — formulario rápido de colocación de órdenes
 * (design doc §4.2). Reutilizable (lo monta /market; /orders puede
 * reutilizarlo): recibe el producto y el self-state.
 *
 * - Side toggle Compra/Venta, cantidad, precio límite y TTL con presets
 *   1 min / 1 h / 1 día / 1 semana SIMULADOS (hint con equivalencia real,
 *   factor de simulación 5×).
 * - Valida ANTES de enviar con el self-state: capital disponible para
 *   compras, inventario disponible para ventas, TTL en [60, 604800].
 * - `client_order_id` generado con crypto.randomUUID() (idempotencia);
 *   se regenera tras cada colocación exitosa y al cambiar de producto.
 * - POST /orders → toast de éxito + invalidación de ["self"], ["orders"]
 *   y ["market", productId]. Un 422 se mapea a errores inline por campo.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  OrderSide,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Problem,
  Product,
  SelfState,
} from "../../api/types";
import { ErrorBanner, Field, showToast } from "../../components";
import {
  fmtMoney,
  fmtQty,
  parseMoneyToCents,
  parseQtyToCent,
  truncId,
} from "../../lib/format";
import {
  DEFAULT_TTL_SIM_SECONDS,
  TTL_PRESETS,
  ttlEquivalenceHint,
} from "./simTime";
import {
  mapProblemToOrderErrors,
  requiredCapitalCents,
  validateOrderDraft,
  type OrderFieldErrors,
  type OrderValidationContext,
} from "./orderValidation";
import styles from "./QuickOrderForm.module.css";

const SIDE_LABEL: Record<OrderSide, string> = {
  buy: "Compra",
  sell: "Venta",
};

function cx(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

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

export interface QuickOrderFormProps {
  /** Producto a operar (del catálogo). */
  product: Product;
  /**
   * Self-state para las validaciones locales (capital / inventario).
   * `null` mientras carga: se omiten esas comprobaciones (el servidor
   * las re-valida siempre).
   */
  self: SelfState | null;
  /** Callback opcional tras colocar la orden con éxito. */
  onPlaced?: (response: PlaceOrderResponse) => void;
}

export function QuickOrderForm({ product, self, onPlaced }: QuickOrderFormProps) {
  const queryClient = useQueryClient();
  const productId = product.product_id;

  const [side, setSide] = useState<OrderSide>("buy");
  const [qtyInput, setQtyInput] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [ttlSim, setTtlSim] = useState<number>(DEFAULT_TTL_SIM_SECONDS);
  /** Id de idempotencia: uno por "intención" de orden. */
  const [clientOrderId, setClientOrderId] = useState<string>(() =>
    crypto.randomUUID(),
  );
  /** Mostrar errores locales solo tras el primer intento de envío. */
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<OrderFieldErrors>({});
  const [serverProblem, setServerProblem] = useState<Problem | null>(null);

  // Cambio de producto = nueva intención: limpiar feedback y regenerar id.
  useEffect(() => {
    setShowErrors(false);
    setServerErrors({});
    setServerProblem(null);
    setClientOrderId(crypto.randomUUID());
  }, [productId]);

  const bankrupt = self !== null && self.agent.status === "bankrupt";

  const position = self?.inventory.find((p) => p.product_id === productId);
  const inventoryAvailableCent = position?.qty_available_cent ?? 0;

  const ctx: OrderValidationContext | null =
    self === null
      ? null
      : {
          capitalAvailableCents: self.capital_available_cents,
          inventoryAvailableCent,
          unit: product.unit,
        };

  const draft = { side, qtyInput, priceInput, ttlSimSeconds: ttlSim };
  const validation = validateOrderDraft(draft, ctx);
  const localErrors: OrderFieldErrors = showErrors ? validation.errors : {};
  // Los errores del servidor (422) tienen prioridad sobre los locales.
  const errors: OrderFieldErrors = { ...localErrors, ...serverErrors };

  // Total estimado (preview): qty × precio, si ambos parsean.
  const qtyCentPreview = parseQtyToCent(qtyInput);
  const priceCentsPreview = parseMoneyToCents(priceInput);
  const totalCents =
    qtyCentPreview !== null &&
    qtyCentPreview >= 1 &&
    priceCentsPreview !== null &&
    priceCentsPreview >= 1
      ? requiredCapitalCents(qtyCentPreview, priceCentsPreview)
      : null;

  const placeOrder = useMutation({
    mutationFn: (body: PlaceOrderRequest) =>
      api.post<PlaceOrderResponse>("/orders", body),
    onSuccess: (res) => {
      const executed = res.trades_generated?.length ?? 0;
      const base = `${SIDE_LABEL[res.side]} de ${fmtQty(
        res.qty_original_cent,
        product.unit,
      )} de ${product.name} a límite ${fmtMoney(res.limit_price_cents)}.`;
      const extra =
        executed > 0
          ? ` Se ejecut${executed === 1 ? "ó 1 trade" : `aron ${executed} trades`} al instante.`
          : "";
      showToast({
        kind: "success",
        title:
          res.status === "completed"
            ? "Orden ejecutada por completo"
            : "Orden colocada",
        body: base + extra,
      });
      // Nueva intención para la próxima orden + limpiar feedback.
      setClientOrderId(crypto.randomUUID());
      setQtyInput("");
      setShowErrors(false);
      setServerErrors({});
      setServerProblem(null);
      void queryClient.invalidateQueries({ queryKey: ["self"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["market", productId] });
      onPlaced?.(res);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 422) {
        const { fields, unassigned } = mapProblemToOrderErrors(err.problem);
        setServerErrors(fields);
        // Sin campo mapeable (o sin errors[]): mostrar el banner con el resto.
        if (unassigned.length > 0 || Object.keys(fields).length === 0) {
          setServerProblem({ ...err.problem, errors: unassigned });
        }
        return;
      }
      setServerProblem(toProblem(err));
    },
  });

  const clearServerFeedback = (fieldsToClear: readonly (keyof OrderFieldErrors)[]) => {
    setServerErrors((prev) => {
      const next = { ...prev };
      for (const f of fieldsToClear) delete next[f];
      return next;
    });
  };

  const onSideChange = (next: OrderSide) => {
    if (next === side) return;
    setSide(next);
    // Cambia la semántica de la validación: descartar feedback previo.
    setServerErrors({});
    setServerProblem(null);
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setServerErrors({});
    setServerProblem(null);
    setShowErrors(true);
    const { errors: localErr, values } = validateOrderDraft(draft, ctx);
    if (values === null || Object.keys(localErr).length > 0) return;
    placeOrder.mutate({
      product_id: productId,
      side,
      qty_cent: values.qty_cent,
      limit_price_cents: values.limit_price_cents,
      ttl_seconds: values.ttl_seconds,
      client_order_id: clientOrderId,
    });
  };

  const disabled = bankrupt || placeOrder.isPending;

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {/* Lado: Compra / Venta */}
      <div
        className={styles.sideToggle}
        role="group"
        aria-label="Lado de la orden"
      >
        <button
          type="button"
          className={cx(
            styles.sideBtn,
            side === "buy" && styles.sideBtnBuyActive,
          )}
          aria-pressed={side === "buy"}
          onClick={() => onSideChange("buy")}
          disabled={disabled}
        >
          Compra
        </button>
        <button
          type="button"
          className={cx(
            styles.sideBtn,
            side === "sell" && styles.sideBtnSellActive,
          )}
          aria-pressed={side === "sell"}
          onClick={() => onSideChange("sell")}
          disabled={disabled}
        >
          Venta
        </button>
      </div>

      <Field
        label={`Cantidad (${product.unit})`}
        error={errors.qty ?? null}
        hint={
          side === "sell" && self !== null
            ? `Disponible para vender: ${fmtQty(inventoryAvailableCent, product.unit)}`
            : undefined
        }
      >
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={qtyInput}
          onChange={(e) => {
            setQtyInput(e.target.value);
            clearServerFeedback(["qty", "form"]);
          }}
          disabled={disabled}
        />
      </Field>

      <Field
        label="Precio límite por unidad"
        error={errors.price ?? null}
        hint={
          side === "buy" && self !== null
            ? `Capital disponible: ${fmtMoney(self.capital_available_cents)}`
            : undefined
        }
      >
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="$0.00"
          value={priceInput}
          onChange={(e) => {
            setPriceInput(e.target.value);
            clearServerFeedback(["price", "form"]);
          }}
          disabled={disabled}
        />
      </Field>

      <Field
        label="Vigencia (TTL simulado)"
        error={errors.ttl ?? null}
        hint={ttlEquivalenceHint(ttlSim)}
      >
        <select
          value={String(ttlSim)}
          onChange={(e) => {
            setTtlSim(Number(e.target.value));
            clearServerFeedback(["ttl"]);
          }}
          disabled={disabled}
        >
          {TTL_PRESETS.map((preset) => (
            <option key={preset.simSeconds} value={String(preset.simSeconds)}>
              {preset.label} (simulado)
            </option>
          ))}
        </select>
      </Field>

      {/* Resumen */}
      <dl className={styles.summary}>
        <dt>Total estimado</dt>
        <dd>{totalCents !== null ? fmtMoney(totalCents) : "—"}</dd>
        {side === "buy" ? (
          <>
            <dt>Capital disponible</dt>
            <dd>{self !== null ? fmtMoney(self.capital_available_cents) : "…"}</dd>
          </>
        ) : (
          <>
            <dt>Inventario disponible</dt>
            <dd>
              {self !== null
                ? fmtQty(inventoryAvailableCent, product.unit)
                : "…"}
            </dd>
          </>
        )}
      </dl>

      {errors.form !== undefined && (
        <p className={styles.formError} role="alert">
          {errors.form}
        </p>
      )}

      {serverProblem !== null && <ErrorBanner problem={serverProblem} />}

      {bankrupt && (
        <p className={styles.bankruptNote} role="alert">
          Agente en quiebra: no puede colocar órdenes.
        </p>
      )}

      <button
        type="submit"
        className={cx(styles.submit, side === "sell" && styles.submitSell)}
        disabled={disabled}
      >
        {placeOrder.isPending
          ? "Enviando…"
          : side === "buy"
            ? `Comprar ${product.name}`
            : `Vender ${product.name}`}
      </button>

      <p className={styles.idemHint} title={clientOrderId}>
        Idempotencia: <code>{truncId(clientOrderId)}…</code> (client_order_id)
      </p>
    </form>
  );
}
