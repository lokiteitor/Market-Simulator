/**
 * Cliente WebSocket del E2E [M11] — WebSocket nativo de Bun.
 *
 * El servidor entrega el JSON `Notification` tal cual (contrato §9):
 *   { type, occurred_at, payload }
 * Canal unidireccional servidor→cliente; esta clase solo acumula mensajes y
 * permite esperar uno que cumpla un predicado.
 */
import { AssertionError } from "./framework";

export interface WsNotification {
  type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

interface Waiter {
  predicate: (n: WsNotification) => boolean;
  resolve: (n: WsNotification) => void;
}

export class WsClient {
  /** Todos los mensajes JSON recibidos, en orden de llegada. */
  readonly messages: WsNotification[] = [];
  closeCode: number | null = null;
  private ws: WebSocket | null = null;
  private waiters: Waiter[] = [];

  constructor(
    private readonly url: string,
    readonly label: string,
  ) {}

  /** Abre la conexión; resuelve en `open`, rechaza en error/close prematuro o timeout. */
  connect(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new AssertionError(`[ws ${this.label}] timeout de ${timeoutMs} ms abriendo la conexión`));
        }
      }, timeoutMs);

      ws.addEventListener("open", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new AssertionError(`[ws ${this.label}] error al conectar a ${this.url}`));
        }
      });
      ws.addEventListener("close", (ev) => {
        this.closeCode = ev.code;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new AssertionError(
              `[ws ${this.label}] conexión cerrada antes de abrir (code=${ev.code}${ev.reason ? `, reason=${ev.reason}` : ""})`,
            ),
          );
        }
      });
      ws.addEventListener("message", (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return; // heartbeats / no-JSON: se ignoran
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const n = parsed as WsNotification;
        this.messages.push(n);
        this.waiters = this.waiters.filter((w) => {
          if (w.predicate(n)) {
            w.resolve(n);
            return false;
          }
          return true;
        });
      });
    });
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Devuelve el primer mensaje (ya recibido o futuro) que cumpla el predicado;
   * AssertionError con diagnóstico si no llega dentro del timeout.
   */
  waitFor(
    description: string,
    predicate: (n: WsNotification) => boolean,
    timeoutMs = 20_000,
  ): Promise<WsNotification> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: (n) => {
          clearTimeout(timer);
          resolve(n);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        const seen = this.messages.map((m) => m.type).join(", ") || "(ninguno)";
        reject(
          new AssertionError(
            `[ws ${this.label}] timeout de ${timeoutMs} ms esperando: ${description}. Tipos recibidos: ${seen}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // best-effort
    }
  }
}
