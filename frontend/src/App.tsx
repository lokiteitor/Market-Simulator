import { Suspense } from "react";
import { AppRoutes } from "./routes";

/** Fallback de carga para las páginas lazy. */
function PageFallback() {
  return (
    <div role="status" aria-live="polite" style={{ padding: "var(--space-6)" }}>
      <span className="muted">Cargando…</span>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <AppRoutes />
    </Suspense>
  );
}
