/**
 * Logger pino singleton (contrato §0/§15).
 *
 * Nivel desde `config.logLevel`; salida legible (pino-pretty) SOLO en
 * development. En src/ se loguea siempre a través de este módulo — nunca
 * console.log.
 */
import { pino } from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.logLevel,
  ...(config.nodeEnv === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }
    : {}),
});
