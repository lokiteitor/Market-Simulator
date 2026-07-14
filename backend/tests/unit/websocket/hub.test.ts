/**
 * Tests unitarios PUROS del hub WS [M7] — sin Redis ni DB: se inyectan
 * fakes vía createWsHub({ createSubscriber, gauge }).
 */
import { describe, expect, test } from "bun:test";
import { createWsHub } from "../../../src/websocket/hub";
import type { ConnectionGauge, HubSocket, SubscriberLike } from "../../../src/websocket/hub";

class FakeSubscriber implements SubscriberLike {
  subscribed = new Set<string>();
  psubscribed = new Set<string>();
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];
  psubscribeCalls: string[] = [];
  punsubscribeCalls: string[] = [];
  quitCalled = false;
  private messageListener: ((channel: string, message: string) => void) | null = null;
  private pmessageListener:
    | ((pattern: string, channel: string, message: string) => void)
    | null = null;

  async subscribe(...channels: string[]): Promise<unknown> {
    for (const c of channels) {
      this.subscribed.add(c);
      this.subscribeCalls.push(c);
    }
    return channels.length;
  }

  async unsubscribe(...channels: string[]): Promise<unknown> {
    for (const c of channels) {
      this.subscribed.delete(c);
      this.unsubscribeCalls.push(c);
    }
    return channels.length;
  }

  async psubscribe(...patterns: string[]): Promise<unknown> {
    for (const p of patterns) {
      this.psubscribed.add(p);
      this.psubscribeCalls.push(p);
    }
    return patterns.length;
  }

  async punsubscribe(...patterns: string[]): Promise<unknown> {
    for (const p of patterns) {
      this.psubscribed.delete(p);
      this.punsubscribeCalls.push(p);
    }
    return patterns.length;
  }

  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "pmessage", listener: (pattern: string, channel: string, message: string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "message" | "pmessage" | "error", listener: unknown): unknown {
    if (event === "message") {
      this.messageListener = listener as (channel: string, message: string) => void;
    } else if (event === "pmessage") {
      this.pmessageListener = listener as (
        pattern: string,
        channel: string,
        message: string,
      ) => void;
    }
    return this;
  }

  async quit(): Promise<unknown> {
    this.quitCalled = true;
    return "OK";
  }

  /** Simula la llegada de un mensaje pub/sub por canal concreto. */
  emit(channel: string, message: string): void {
    this.messageListener?.(channel, message);
  }

  /**
   * Simula un publish visto TAMBIÉN por el patrón `product:*` (Redis entrega
   * el mismo publish por ambas vías cuando canal y patrón están suscritos).
   */
  emitProduct(productId: string, message: string): void {
    const channel = `product:${productId}`;
    if (this.subscribed.has(channel)) this.messageListener?.(channel, message);
    if (this.psubscribed.has("product:*")) {
      this.pmessageListener?.("product:*", channel, message);
    }
  }
}

class FakeSocket implements HubSocket {
  readyState = 1; // OPEN
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  terminated = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.closedWith = { code, reason };
  }

  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
  }
}

class FakeGauge implements ConnectionGauge {
  value = 0;
  inc(): void {
    this.value += 1;
  }
  dec(): void {
    this.value -= 1;
  }
}

function makeHub() {
  const sub = new FakeSubscriber();
  const gauge = new FakeGauge();
  const hub = createWsHub({ createSubscriber: () => sub, gauge });
  return { hub, sub, gauge };
}

describe("wsHub", () => {
  test("primera conexión: suscribe broadcast y agent:{id}; gauge sube", async () => {
    const { hub, sub, gauge } = makeHub();
    const socket = new FakeSocket();

    await hub.addConnection("a1", socket);

    expect(sub.subscribed.has("broadcast")).toBe(true);
    expect(sub.subscribed.has("agent:a1")).toBe(true);
    expect(gauge.value).toBe(1);
    expect(hub.activeConnectionCount()).toBe(1);
  });

  test("mensaje de canal personal llega tal cual SOLO a los sockets de ese agente", async () => {
    const { hub, sub } = makeHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    await hub.addConnection("a1", s1);
    await hub.addConnection("a2", s2);

    const payload = '{"type":"order_executed","occurred_at":"2026-07-03T00:00:00Z","payload":{}}';
    sub.emit("agent:a1", payload);

    expect(s1.sent).toEqual([payload]); // reenvío byte a byte
    expect(s2.sent).toEqual([]);
  });

  test("broadcast llega a todos los sockets de todos los agentes", async () => {
    const { hub, sub } = makeHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const s3 = new FakeSocket();
    await hub.addConnection("a1", s1);
    await hub.addConnection("a1", s2);
    await hub.addConnection("a2", s3);

    sub.emit("broadcast", '{"type":"agent_bankrupt"}');

    for (const s of [s1, s2, s3]) {
      expect(s.sent).toEqual(['{"type":"agent_bankrupt"}']);
    }
  });

  test("segundo socket del mismo agente no re-suscribe el canal", async () => {
    const { hub, sub, gauge } = makeHub();
    await hub.addConnection("a1", new FakeSocket());
    await hub.addConnection("a1", new FakeSocket());

    expect(sub.subscribeCalls.filter((c) => c === "agent:a1")).toHaveLength(1);
    expect(gauge.value).toBe(2);
    expect(hub.activeConnectionCount()).toBe(2);
  });

  test("addConnection es idempotente por (agente, socket)", async () => {
    const { hub, gauge } = makeHub();
    const socket = new FakeSocket();
    await hub.addConnection("a1", socket);
    await hub.addConnection("a1", socket);

    expect(gauge.value).toBe(1);
    expect(hub.activeConnectionCount()).toBe(1);
  });

  test("no envía a sockets que no están OPEN", async () => {
    const { hub, sub } = makeHub();
    const socket = new FakeSocket();
    await hub.addConnection("a1", socket);
    socket.readyState = 2; // CLOSING

    sub.emit("agent:a1", "x");

    expect(socket.sent).toEqual([]);
  });

  test("removeConnection del último socket desuscribe el canal del agente", async () => {
    const { hub, sub, gauge } = makeHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    await hub.addConnection("a1", s1);
    await hub.addConnection("a1", s2);

    await hub.removeConnection("a1", s1);
    expect(sub.unsubscribeCalls).toEqual([]); // aún queda s2

    await hub.removeConnection("a1", s2);
    expect(sub.unsubscribeCalls).toEqual(["agent:a1"]);
    expect(gauge.value).toBe(0);
    expect(hub.activeConnectionCount()).toBe(0);
  });

  test("removeConnection es idempotente (no doble-decrementa el gauge)", async () => {
    const { hub, gauge } = makeHub();
    const socket = new FakeSocket();
    await hub.addConnection("a1", socket);

    await hub.removeConnection("a1", socket);
    await hub.removeConnection("a1", socket);
    await hub.removeConnection("desconocido", socket);

    expect(gauge.value).toBe(0);
  });

  test("carrera remove→add: el agente queda suscrito al converger", async () => {
    const { hub, sub } = makeHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    await hub.addConnection("a1", s1);

    // Sin await intermedio: las ops Redis quedan encoladas y se resuelven en FIFO.
    const removal = hub.removeConnection("a1", s1);
    const addition = hub.addConnection("a1", s2);
    await Promise.all([removal, addition]);

    expect(sub.subscribed.has("agent:a1")).toBe(true);
    sub.emit("agent:a1", "hola");
    expect(s2.sent).toEqual(["hola"]);
  });

  test("mensajes de canales sin sockets o desconocidos se ignoran sin error", async () => {
    const { hub, sub } = makeHub();
    await hub.addConnection("a1", new FakeSocket());

    expect(() => {
      sub.emit("agent:fantasma", "x");
      sub.emit("otra-cosa", "y");
    }).not.toThrow();
  });

  test("close(): cierra sockets con 1001, quita la conexión Redis y deja gauge en 0", async () => {
    const { hub, sub, gauge } = makeHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    await hub.addConnection("a1", s1);
    await hub.addConnection("a2", s2);

    await hub.close();

    expect(s1.closedWith?.code).toBe(1001);
    expect(s2.closedWith?.code).toBe(1001);
    expect(sub.quitCalled).toBe(true);
    expect(gauge.value).toBe(0);
    expect(hub.activeConnectionCount()).toBe(0);

    // El evento close del socket dispara removeConnection después: no-op.
    await hub.removeConnection("a1", s1);
    expect(gauge.value).toBe(0);

    // Conexiones nuevas tras el shutdown se rechazan con 1001.
    const s3 = new FakeSocket();
    await hub.addConnection("a3", s3);
    expect(s3.closedWith?.code).toBe(1001);
    expect(hub.activeConnectionCount()).toBe(0);
  });

  test("tape: solo los suscritos al producto reciben trade_printed", async () => {
    const { hub, sub } = makeHub();
    const trigo = new FakeSocket();
    const pan = new FakeSocket();
    const nadie = new FakeSocket();
    await hub.addConnection("a1", trigo);
    await hub.addConnection("a2", pan);
    await hub.addConnection("a3", nadie);
    await hub.setProductSubscriptions(trigo, ["trigo"]);
    await hub.setProductSubscriptions(pan, ["pan", "harina"]);

    expect(sub.subscribed.has("product:trigo")).toBe(true);
    expect(sub.subscribed.has("product:pan")).toBe(true);
    sub.emitProduct("trigo", "t1");
    sub.emitProduct("pan", "t2");

    expect(trigo.sent).toEqual(["t1"]);
    expect(pan.sent).toEqual(["t2"]);
    expect(nadie.sent).toEqual([]);
  });

  test("tape: el firehose ('all') recibe todos los productos sin duplicados", async () => {
    const { hub, sub } = makeHub();
    const spa = new FakeSocket();
    const bot = new FakeSocket();
    await hub.addConnection("admin", spa);
    await hub.addConnection("a1", bot);
    await hub.setProductSubscriptions(spa, "all");
    await hub.setProductSubscriptions(bot, ["trigo"]);

    expect(sub.psubscribed.has("product:*")).toBe(true);
    // Redis entrega "trigo" por el canal concreto Y por el patrón: cada
    // socket debe recibirlo exactamente una vez.
    sub.emitProduct("trigo", "t1");
    sub.emitProduct("exotico", "t2"); // sin canal concreto, solo patrón

    expect(spa.sent).toEqual(["t1", "t2"]);
    expect(bot.sent).toEqual(["t1"]);
  });

  test("tape: re-suscribir reemplaza (diff) y desuscribe canales huérfanos", async () => {
    const { hub, sub } = makeHub();
    const s = new FakeSocket();
    await hub.addConnection("a1", s);
    await hub.setProductSubscriptions(s, ["trigo", "pan"]);
    await hub.setProductSubscriptions(s, ["pan", "harina"]);

    expect(sub.subscribed.has("product:trigo")).toBe(false);
    expect(sub.subscribed.has("product:pan")).toBe(true);
    expect(sub.subscribed.has("product:harina")).toBe(true);
    // "pan" se mantuvo: no debe re-suscribirse.
    expect(sub.subscribeCalls.filter((c) => c === "product:pan")).toHaveLength(1);

    sub.emitProduct("trigo", "viejo");
    sub.emitProduct("harina", "nuevo");
    expect(s.sent).toEqual(["nuevo"]);
  });

  test("tape: dos sockets del mismo producto comparten canal; el último lo libera", async () => {
    const { hub, sub } = makeHub();
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    await hub.addConnection("a1", s1);
    await hub.addConnection("a2", s2);
    await hub.setProductSubscriptions(s1, ["trigo"]);
    await hub.setProductSubscriptions(s2, ["trigo"]);
    expect(sub.subscribeCalls.filter((c) => c === "product:trigo")).toHaveLength(1);

    await hub.removeConnection("a1", s1);
    expect(sub.subscribed.has("product:trigo")).toBe(true); // queda s2

    await hub.removeConnection("a2", s2);
    expect(sub.unsubscribeCalls).toContain("product:trigo");
    expect(sub.subscribed.has("product:trigo")).toBe(false);
  });

  test("tape: cambiar de lista a 'all' y de vuelta gestiona el patrón", async () => {
    const { hub, sub } = makeHub();
    const s = new FakeSocket();
    await hub.addConnection("a1", s);
    await hub.setProductSubscriptions(s, ["trigo"]);
    await hub.setProductSubscriptions(s, "all");

    expect(sub.subscribed.has("product:trigo")).toBe(false);
    expect(sub.psubscribed.has("product:*")).toBe(true);

    await hub.setProductSubscriptions(s, ["pan"]);
    expect(sub.psubscribed.has("product:*")).toBe(false);
    expect(sub.punsubscribeCalls).toEqual(["product:*"]);
    expect(sub.subscribed.has("product:pan")).toBe(true);
  });

  test("tape: removeConnection del último firehose des-psuscribe el patrón", async () => {
    const { hub, sub } = makeHub();
    const s = new FakeSocket();
    await hub.addConnection("a1", s);
    await hub.setProductSubscriptions(s, "all");

    await hub.removeConnection("a1", s);
    expect(sub.psubscribed.has("product:*")).toBe(false);

    sub.emitProduct("trigo", "x");
    expect(s.sent).toEqual([]);
  });

  test("un socket que lanza en send no impide la entrega a los demás", async () => {
    const { hub, sub } = makeHub();
    const roto = new FakeSocket();
    roto.send = () => {
      throw new Error("boom");
    };
    const sano = new FakeSocket();
    await hub.addConnection("a1", roto);
    await hub.addConnection("a1", sano);

    sub.emit("agent:a1", "msg");

    expect(sano.sent).toEqual(["msg"]);
  });
});
