/**
 * CancelOrderModal — confirmación de DELETE /orders/{id}, compartida por
 * OrdersPage y DashboardPage (antes estaba duplicada casi literalmente).
 *
 * Dice explícitamente QUÉ se devuelve, que es la duda recurrente: cancelar y
 * expirar comparten `releaseOrderReserves` en el backend, así que el capital
 * reservado vuelve a disponible y la mercancía reservada vuelve a sus lotes.
 *
 * Si la orden ya venció pero el barrido aún no la ha marcado (estado derivado
 * `expiring`), el diálogo cambia de tono: no se está "cancelando" nada que
 * pudiera casar, solo se adelanta la liberación de las reservas.
 */
import type { Order } from "../../api/types";
import { Badge, ErrorBanner, Modal, type ProblemLike } from "../../components";
import { fmtMoney, fmtQty, truncId } from "../../lib/format";
import {
  orderDisplayStatus,
  reserveRelease,
  type OrderDisplayStatus,
} from "./orderDisplayStatus";
import { ORDER_SIDE_LABEL } from "./orderLabels";
import styles from "./CancelOrderModal.module.css";

export interface CancelOrderModalProps {
  /** Orden a cancelar; null = modal cerrado. */
  order: Order | null;
  /** Reloj del cliente para derivar el estado de presentación. */
  nowMs: number;
  productName: (productId: string) => string;
  productUnit: (productId: string) => string | undefined;
  onClose: () => void;
  onConfirm: (orderId: string) => void;
  pending: boolean;
  /** Problem de la mutación fallida (si la hubo). */
  error?: ProblemLike | null;
  /** Escritura bloqueada (agente en quiebra). */
  disabled?: boolean;
}

function cx(...names: Array<string | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** Texto de lo que el backend devolverá al liberar las reservas. */
function releaseText(order: Order, unit: string | undefined): string {
  const release = reserveRelease(order);
  return release.kind === "capital"
    ? `${fmtMoney(release.cents)} de capital reservado`
    : `${fmtQty(release.qtyCent, unit)} de mercancía reservada`;
}

export function CancelOrderModal({
  order,
  nowMs,
  productName,
  productUnit,
  onClose,
  onConfirm,
  pending,
  error,
  disabled = false,
}: CancelOrderModalProps) {
  const display: OrderDisplayStatus | null =
    order !== null ? orderDisplayStatus(order, nowMs) : null;
  const expiring = display === "expiring";

  return (
    <Modal
      open={order !== null}
      onClose={() => {
        if (!pending) onClose();
      }}
      title={expiring ? "Liberar reservas" : "Cancelar orden"}
    >
      {order !== null && (
        <div className={styles["body"]}>
          <p>
            {expiring ? (
              <>
                La orden{" "}
                <code className={styles["mono"]}>{truncId(order.order_id)}</code>{" "}
                ya venció: no puede casar. Sus reservas se liberarán solas en
                unos segundos; confirma para hacerlo ahora.
              </>
            ) : (
              <>
                ¿Seguro que quieres cancelar la orden{" "}
                <code className={styles["mono"]}>{truncId(order.order_id)}</code>
                ?
              </>
            )}
          </p>
          <dl className={styles["detailList"]}>
            <dt>Producto</dt>
            <dd>{productName(order.product_id)}</dd>
            <dt>Lado</dt>
            <dd>
              <Badge kind={order.side}>{ORDER_SIDE_LABEL[order.side]}</Badge>
            </dd>
            <dt>Pendiente</dt>
            <dd className={styles["mono"]}>
              {fmtQty(order.qty_pending_cent, productUnit(order.product_id))}
            </dd>
            <dt>Precio límite</dt>
            <dd className={styles["mono"]}>{fmtMoney(order.limit_price_cents)}</dd>
            <dt>Se te devolverá</dt>
            <dd className={styles["mono"]}>
              {releaseText(order, productUnit(order.product_id))}
            </dd>
          </dl>
          <p className={styles["subtle"]}>
            La liberación es íntegra y gratuita: el capital vuelve a disponible y
            la mercancía a sus lotes de origen.
          </p>
          {error != null && <ErrorBanner problem={error} />}
          <div className={styles["actions"]}>
            <button
              type="button"
              className={cx(styles["btn"], styles["btnSecondary"])}
              onClick={onClose}
              disabled={pending}
            >
              {expiring ? "Volver" : "Mantener orden"}
            </button>
            <button
              type="button"
              className={cx(styles["btn"], styles["btnDanger"])}
              onClick={() => onConfirm(order.order_id)}
              disabled={pending || disabled}
            >
              {pending
                ? expiring
                  ? "Liberando…"
                  : "Cancelando…"
                : expiring
                  ? "Liberar reservas"
                  : "Cancelar orden"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
