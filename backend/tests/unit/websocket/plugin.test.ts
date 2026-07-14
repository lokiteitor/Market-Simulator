/**
 * Tests unitarios del parser de mensajes cliente→servidor del plugin WS:
 * el único mensaje aceptado es subscribe_products (contrato §12).
 */
import { describe, expect, test } from "bun:test";
import { parseSubscribeProducts } from "../../../src/websocket/plugin";

describe("parseSubscribeProducts", () => {
  test("acepta el mensaje válido (string y Buffer)", () => {
    const msg = '{"type":"subscribe_products","product_ids":["trigo","pan"]}';
    expect(parseSubscribeProducts(msg)).toEqual(["trigo", "pan"]);
    expect(parseSubscribeProducts(Buffer.from(msg, "utf8"))).toEqual(["trigo", "pan"]);
  });

  test("acepta el comodín '*' y la lista vacía (desuscripción total)", () => {
    expect(
      parseSubscribeProducts('{"type":"subscribe_products","product_ids":["*"]}'),
    ).toEqual(["*"]);
    expect(
      parseSubscribeProducts('{"type":"subscribe_products","product_ids":[]}'),
    ).toEqual([]);
  });

  test("rechaza JSON inválido, tipos ajenos y payloads malformados", () => {
    expect(parseSubscribeProducts("no-es-json")).toBeNull();
    expect(parseSubscribeProducts('{"type":"otro","product_ids":["a"]}')).toBeNull();
    expect(parseSubscribeProducts('{"type":"subscribe_products"}')).toBeNull();
    expect(
      parseSubscribeProducts('{"type":"subscribe_products","product_ids":[1,2]}'),
    ).toBeNull();
    expect(parseSubscribeProducts(42)).toBeNull();
    expect(parseSubscribeProducts(null)).toBeNull();
  });

  test("rechaza listas o ids fuera de límite (anti-abuso)", () => {
    const many = JSON.stringify({
      type: "subscribe_products",
      product_ids: Array.from({ length: 257 }, (_, i) => `p${i}`),
    });
    expect(parseSubscribeProducts(many)).toBeNull();
    const longId = JSON.stringify({
      type: "subscribe_products",
      product_ids: ["x".repeat(129)],
    });
    expect(parseSubscribeProducts(longId)).toBeNull();
  });
});
