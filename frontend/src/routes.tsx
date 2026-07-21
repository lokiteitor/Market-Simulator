import { lazy } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";

import { useAuth } from "./auth/AuthContext";
import { useRequireAuth } from "./auth/useRequireAuth";
import { useRequireRole } from "./auth/useRequireRole";
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
const InstallationsPage = lazy(
  () => import("./pages/installations/InstallationsPage"),
);
const HistoryPage = lazy(() => import("./pages/history/HistoryPage"));
const ProfilePage = lazy(() => import("./pages/profile/ProfilePage"));
// Panel admin (solo rol `admin`).
const AdminOverviewPage = lazy(() => import("./pages/admin/AdminOverviewPage"));
const AdminAgentsPage = lazy(() => import("./pages/admin/AdminAgentsPage"));
const AdminMarketPage = lazy(() => import("./pages/admin/AdminMarketPage"));
const AdminProductionPage = lazy(() => import("./pages/admin/AdminProductionPage"));

/**
 * Envoltorio de rutas protegidas: redirige a /auth si no hay sesión y
 * renderiza el layout común (Sidebar + Header con indicador WS y campana).
 * Los admin caen en su propio subárbol (ProtectedAdmin).
 */
function Protected() {
  useRequireAuth();
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

/**
 * Rutas de administración: exigen sesión Y rol `admin` (si no, redirige a
 * /dashboard). Comparten el layout común (el Sidebar detecta el rol y muestra
 * la navegación admin).
 */
function ProtectedAdmin() {
  useRequireAuth();
  useRequireRole("admin");
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

/** Índice: los admin arrancan en /admin; el resto en /dashboard. */
function HomeRedirect() {
  const { agent } = useAuth();
  const to = agent?.agent.role === "admin" ? "/admin" : "/dashboard";
  return <Navigate to={to} replace />;
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
        <Route path="/installations" element={<InstallationsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Route>

      {/* Protegidas admin: sesión + rol admin */}
      <Route element={<ProtectedAdmin />}>
        <Route path="/admin" element={<AdminOverviewPage />} />
        <Route path="/admin/agents" element={<AdminAgentsPage />} />
        <Route path="/admin/market" element={<AdminMarketPage />} />
        <Route path="/admin/production" element={<AdminProductionPage />} />
      </Route>

      {/* Redirecciones */}
      <Route path="/" element={<HomeRedirect />} />
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}
