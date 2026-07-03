/**
 * OrderFormModal [FE7] — Modal de creación de órdenes (design doc §4.2).
 *
 * Mismo formulario que el "quick form" de mercado, implementado LOCALMENTE
 * (decisión documentada en orderFormLogic.ts): producto, lado, cantidad,
 * precio límite y TTL simulado con presets. Validación client-side
 * (capital/inventario/TTL) + mapeo de errores 422 por campo, idempotencia
 * con `client_order_id = crypto.randomUUID()` (regenerado en cada apertura),
 * y toast con los trades generados en el primer ciclo de matching.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  OrderSide,
  PlaceOrderRequest,
  PlaceOrderResponse,
  Problem,
  Product,
  SelfState,
} from "../../api/types";
import { ErrorBanner, Field, Modal, showToast } from "../../components";
import { fmtMoney, fmtQty } from "../../lib/format";
import { splitProblemByField } from "../auth/validation";
import {
  DEFAULT_TTL_SIM_SECONDS,
  TTL_PRESETS,
  ttlEquivalenceHint,
} from "../market/simTime";
import { ORDER_SIDE_LABEL } from "./orderLabels";
import {
  notionalCents,
  ORDER_FIELDS,
  validateOrderForm,
  type OrderFieldErrors,
} from "./orderFormLogic";
import styles from "./OrderFormModal.module.css";

export interface OrderFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Producto preseleccionado (opcional). */
  initialProductId?: string;
  /** Lado preseleccionado (default: compra). */
  initialSide?: OrderSide;
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

export function OrderFormModal({
  open,
  onClose,
  initialProductId,
  initialSide,
}: OrderFormModalProps) {
  const queryClient = useQueryClient();

  // ---- Datos (comparten caché con el resto de la app) ----------------------
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
  });
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  const self = selfQuery.data ?? null;
  const bankrupt = self !== null && self.agent.status === "bankrupt";
  const products = useMemo(
    () =>
      [...(productsQuery.data ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name, "es"),
      ),
    [productsQuery.data],
  );

  // ---- Estado del formulario -------------------------------------------------
  const [productId, setProductId] = useState("");
  const [side, setSide] = useState<OrderSide>("buy");
  const [qtyText, setQtyText] = useState("");
  const [priceText, setPriceText] = useState("");
  const [ttlSimSeconds, setTtlSimSeconds] = useState(DEFAULT_TTL_SIM_SECONDS);
  const [clientOrderId, setClientOrderId] = useState("");
  const [fieldErrors, setFieldErrors] = useState<OrderFieldErrors>({});
  const [domainError, setDomainError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Problem | null>(null);

  // Reset completo en cada apertura; el client_order_id se genera UNA vez por
  // apertura para que los reintentos del mismo envío sean idempotentes.
  useEffect(() => {
    if (!open) return;
    setProductId(initialProductId ?? "");
    setSide(initialSide ?? "buy");
    setQtyText("");
    setPriceText("");
    setTtlSimSeconds(DEFAULT_TTL_SIM_SECONDS);
    setClientOrderId(crypto.randomUUID());
    setFieldErrors({});
    setDomainError(null);
    setBanner(null);
  }, [open, initialProductId, initialSide]);

  // ---- Derivados para la vista previa ----------------------------------------
  const product = products.find((p) => p.product_id === productId) ?? null;
  const inventoryAvailableCent =
    self?.inventory.find((i) => i.product_id === productId)
      ?.qty_available_cent ?? 0;
  const capitalAvailableCents = self?.capital_available_cents ?? 0;

  const preview = useMemo(() => {
    const result = validateOrderForm(
      {
        productId,
        side,
        qtyText,
        priceText,
        ttlSimSeconds,
        clientOrderId,
      },
      {
        capitalAvailableCents,
        inventoryAvailableCent,
        ...(product?.unit !== undefined ? { unit: product.unit } : {}),
      },
    );
    const req = result.request;
    const notional =
      req !== null
        ? notionalCents(req.qty_cent, req.limit_price_cents)
        : null;
    return { result, notional };
  }, [
    productId,
    side,
    qtyText,
    priceText,
    ttlSimSeconds,
    clientOrderId,
    capitalAvailableCents,
    inventoryAvailableCent,
    product,
  ]);

  // ---- Envío -------------------------------------------------------------------
  const placeOrder = useMutation({
    mutationFn: (req: PlaceOrderRequest) =>
      api.post<PlaceOrderResponse>("/orders", req),
    onSuccess: (res) => {
      const unit = products.find(
        (p) => p.product_id === res.product_id,
      )?.unit;
      const name =
        products.find((p) => p.product_id === res.product_id)?.name ??
        "producto";
      const trades = res.trades_generated ?? [];
      const bodyParts = [
        `${ORDER_SIDE_LABEL[res.side]} de ${fmtQty(res.qty_original_cent, unit)} de ${name}`,
        `límite ${fmtMoney(res.limit_price_cents)}`,
      ];
      if (trades.length > 0) {
        bodyParts.push(
          `${trades.length} ${trades.length === 1 ? "trade inmediato" : "trades inmediatos"}`,
        );
      }
      showToast({
        kind: "success",
        title:
          res.status === "completed"
            ? "Orden ejecutada por completo"
            : "Orden colocada",
        body: bodyParts.join(" · "),
      });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["self"] });
      void queryClient.invalidateQueries({
        queryKey: ["market", res.product_id],
      });
      void queryClient.invalidateQueries({ queryKey: ["history"] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        const { fields, general } = splitProblemByField(
          err.problem,
          ORDER_FIELDS,
        );
        setFieldErrors(fields as OrderFieldErrors);
        setBanner(general);
      } else {
        setBanner(toProblem(err));
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const { result } = preview;
    setFieldErrors(result.errors);
    setDomainError(result.domainError);
    if (result.request === null) return;
    placeOrder.mutate(result.request);
  };

  const close = () => {
    if (!placeOrder.isPending) onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Nueva orden">
      <form className={styles["form"]} onSubmit={submit} noValidate>
        {bankrupt && (
          <ErrorBanner
            problem={{
              title: "Agente en quiebra",
              detail: "No puedes colocar órdenes: el agente salió del mercado.",
            }}
          />
        )}

        {/* Lado: toggle compra/venta (radiogroup accesible) */}
        <fieldset className={styles["sideFieldset"]}>
          <legend className={styles["sideLegend"]}>Lado</legend>
          <div
            className={styles["sideToggle"]}
            role="radiogroup"
            aria-label="Lado de la orden"
          >
            {(["buy", "sell"] as const).map((s) => (
              <label
                key={s}
                className={`${styles["sideOption"]} ${
                  side === s
                    ? s === "buy"
                      ? (styles["sideBuyActive"] ?? "")
                      : (styles["sideSellActive"] ?? "")
                    : ""
                }`}
              >
                <input
                  type="radio"
                  name="order-side"
                  value={s}
                  checked={side === s}
                  onChange={() => setSide(s)}
                  className={styles["sideRadio"]}
                />
                {ORDER_SIDE_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>

        <Field
          label="Producto"
          error={fieldErrors.product_id ?? null}
          hint={
            side === "sell" && product !== null
              ? `Disponible en inventario: ${fmtQty(inventoryAvailableCent, product.unit)}`
              : undefined
          }
        >
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={productsQuery.isPending}
          >
            <option value="">
              {productsQuery.isPending
                ? "Cargando catálogo…"
                : "Selecciona un producto"}
            </option>
            {products.map((p) => (
              <option key={p.product_id} value={p.product_id}>
                {p.name} ({p.unit})
              </option>
            ))}
          </select>
        </Field>

        <div className={styles["row"]}>
          <Field
            label={`Cantidad${product !== null ? ` (${product.unit})` : ""}`}
            error={fieldErrors.qty_cent ?? null}
          >
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Precio límite ($ por unidad)"
            error={fieldErrors.limit_price_cents ?? null}
          >
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>

        <Field
          label="TTL (tiempo de vida, simulado)"
          error={fieldErrors.ttl_seconds ?? null}
          hint={ttlEquivalenceHint(ttlSimSeconds)}
        >
          <select
            value={ttlSimSeconds}
            onChange={(e) => setTtlSimSeconds(Number(e.target.value))}
          >
            {TTL_PRESETS.map((p) => (
              <option key={p.simSeconds} value={p.simSeconds}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Vista previa: importe, capital/inventario y TTL */}
        <dl className={styles["preview"]}>
          <dt>{side === "buy" ? "Capital a reservar" : "Importe máximo"}</dt>
          <dd className={styles["mono"]}>
            {preview.notional !== null ? fmtMoney(preview.notional) : "—"}
          </dd>
          {side === "buy" ? (
            <>
              <dt>Capital disponible</dt>
              <dd className={styles["mono"]}>
                {self !== null ? fmtMoney(capitalAvailableCents) : "…"}
              </dd>
            </>
          ) : (
            <>
              <dt>Inventario disponible</dt>
              <dd className={styles["mono"]}>
                {self !== null
                  ? fmtQty(inventoryAvailableCent, product?.unit)
                  : "…"}
              </dd>
            </>
          )}
        </dl>

        {domainError !== null && (
          <p className={styles["domainError"]} role="alert">
            {domainError}
          </p>
        )}

        {banner !== null && <ErrorBanner problem={banner} />}

        <div className={styles["actions"]}>
          <button
            type="button"
            className={`${styles["btn"]} ${styles["btnSecondary"]}`}
            onClick={close}
            disabled={placeOrder.isPending}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className={`${styles["btn"]} ${styles["btnPrimary"]}`}
            disabled={placeOrder.isPending || bankrupt}
          >
            {placeOrder.isPending
              ? "Enviando…"
              : side === "buy"
                ? "Colocar orden de compra"
                : "Colocar orden de venta"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
