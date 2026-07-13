/**
 * Controller de la ventanilla del banco central (patrón oro) — [bank].
 * El service ya devuelve DTOs snake_case del openapi; el controller solo
 * enruta (sin lógica), como el resto de controllers.
 */
import type { BankInfoDto, ConvertRequestDto, GoldConversionDto } from "../schemas/bank";
import { bankService } from "../services/bank-service";

export const bankController = {
  /** GET /bank → 200 BankInfo. */
  async getBankInfo(): Promise<BankInfoDto> {
    return bankService.getBankInfo();
  },

  /** POST /bank/convert → 201 GoldConversion. */
  async convert(agentId: string, body: ConvertRequestDto): Promise<GoldConversionDto> {
    return bankService.convert(agentId, body);
  },
};
