/**
 * uuid.ts — Utilidad para generar UUIDs v4 de forma segura.
 *
 * Ofrece un fallback para contextos no seguros (HTTP por IP de red local)
 * donde `crypto.randomUUID` no está expuesto por el navegador.
 */

export function generateUUID(): string {
  // 1. Intentar usar la API nativa crypto.randomUUID si está disponible
  if (
    typeof window !== "undefined" &&
    window.crypto &&
    typeof window.crypto.randomUUID === "function"
  ) {
    return window.crypto.randomUUID();
  }

  // 2. Fallback usando crypto.getRandomValues (suele estar disponible en contextos no seguros)
  if (
    typeof window !== "undefined" &&
    window.crypto &&
    typeof window.crypto.getRandomValues === "function"
  ) {
    return (([1e7] as unknown as string) + -1e3 + -4e3 + -8e3 + -1e11).replace(
      /[018]/g,
      (c: any) =>
        (
          c ^
          (window.crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (c / 4)))
        ).toString(16)
    );
  }

  // 3. Fallback con Math.random (último recurso)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
