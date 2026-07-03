/**
 * ConnectionContext — contexto simple con el estado de la conexión WS.
 *
 * El Header lo consume para pintar el indicador "Conectado / Sin conexión".
 * Quien conozca el estado real (p.ej. el proveedor de notificaciones WS o el
 * árbol de la app) envuelve el layout con:
 *
 *   <ConnectionContext.Provider value={{ connected }}>…</ConnectionContext.Provider>
 *
 * Alternativamente, `<Layout connected={…}>` / `<Header connected={…}>`
 * aceptan la prop directa, que tiene prioridad sobre el contexto.
 * Default sin provider: desconectado.
 */
import { createContext, useContext } from "react";

export interface ConnectionState {
  connected: boolean;
}

export const ConnectionContext = createContext<ConnectionState>({
  connected: false,
});

export function useConnection(): ConnectionState {
  return useContext(ConnectionContext);
}
