/**
 * Schemas Zod de la ventanilla del banco central (patrón oro) — [bank].
 *
 * openapi: GET /bank (BankInfo) y POST /bank/convert (ConvertRequest →
 * GoldConversion). Sin fees: la ventanilla acuña (sell_gold) y destruye
 * (buy_gold) dinero a la banda [window_bid, window_ask] alrededor de la
 * paridad fija de la corrida.
 */
import { z } from "zod";

export const ConversionDirectionSchema = z.enum(["buy_gold", "sell_gold"]);
export type ConversionDirectionDto = z.infer<typeof ConversionDirectionSchema>;

/** openapi BankInfo: política monetaria + estado vivo del banco. */
export const BankInfoSchema = z.object({
  bank_agent_id: z.uuid(),
  product_id: z.uuid(),
  parity_cents_per_unit: z.number().int().min(1),
  window_bid_cents: z.number().int().min(1),
  window_ask_cents: z.number().int().min(1),
  coverage_ratio_bps: z.number().int().min(1),
  initial_money_cents: z.number().int().min(0),
  money_issued_cents: z.number().int().min(0),
  money_burned_cents: z.number().int().min(0),
  /** Capacidad TOTAL de emisión respaldada por el oro actual del banco. */
  issuance_capacity_cents: z.number().int().min(0),
  bank_gold_available_cent: z.number().int().min(0),
  bank_capital_available_cents: z.number().int().min(0),
  /** Yacimiento minable restante; null si el producto no tiene depósito. */
  deposit_remaining_cent: z.number().int().min(0).nullable(),
});
export type BankInfoDto = z.infer<typeof BankInfoSchema>;

/** Body de POST /bank/convert. */
export const ConvertRequestSchema = z.object({
  direction: ConversionDirectionSchema,
  qty_cent: z.number().int().min(1),
});
export type ConvertRequestDto = z.infer<typeof ConvertRequestSchema>;

/** openapi GoldConversion (respuesta 201 y payload de notificación). */
export const GoldConversionSchema = z.object({
  conversion_id: z.uuid(),
  agent_id: z.uuid(),
  direction: ConversionDirectionSchema,
  product_id: z.uuid(),
  qty_cent: z.number().int().min(1),
  price_cents_per_unit: z.number().int().min(1),
  total_cents: z.number().int().min(0),
  executed_at: z.iso.datetime(),
});
export type GoldConversionDto = z.infer<typeof GoldConversionSchema>;
