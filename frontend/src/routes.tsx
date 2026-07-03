import { lazy } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";

import { useRequireAuth } from "./auth/useRequireAuth";
import { Layout } from "./components/Layout";

// Páginas lazy — módulos de FE4–FE7 (paths del contrato; export default por página).
const AuthPage = lazy(() => import("./pages/auth/AuthPage"));
const DashboardPage = lazy(() => import("./pages/dashboard/DashboardPage"));
const MarketPage = lazy(() => import("./pages/market/MarketPage"));
const CatalogPage = lazy(() => import("./pages/catalog/CatalogPage"));
const OrdersPage = lazy(() => import("./pages/orders/OrdersPage"));
const TransformationsPage = lazy(
  () => import("./pages/transformations/TransformationsPage"),
);
const HistoryPage = lazy(() => import("./pages/history/HistoryPage"));
const ProfilePage = lazy(() => import("./pages/profile/ProfilePage"));

/**
 * Envoltorio de rutas protegidas: redirige a /auth si no hay sesión y
 * renderiza el layout común (Sidebar + Header con indicador WS y campana).
 */
function Protected() {
  useRequireAuth();
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      {/* Pública: login/registro */}
      <Route path="/auth" element={<AuthPage />} />

      {/* Protegidas: layout común */}
      <Route element={<Protected />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/market" element={<MarketPage />} />
        <Route path="/market/:productId" element={<MarketPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/orders" element={<OrdersPage />} />
        <Route path="/transformations" element={<TransformationsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>

      {/* Redirecciones */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
