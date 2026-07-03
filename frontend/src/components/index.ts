/**
 * Barrel de componentes compartidos [FE3].
 * Cada componente también es importable directo: "components/Modal", etc.
 */
export { Badge, type BadgeKind, type BadgeProps } from "./Badge";
export {
  ConnectionContext,
  useConnection,
  type ConnectionState,
} from "./ConnectionContext";
export { CopyId, type CopyIdProps } from "./CopyId";
export {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "./DataTable";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export {
  ErrorBanner,
  type ErrorBannerProps,
  type ProblemErrorItem,
  type ProblemLike,
} from "./ErrorBanner";
export { Field, type FieldProps } from "./Field";
export { Header, type HeaderProps } from "./Header";
export { Layout, type LayoutProps } from "./Layout";
export { Modal, type ModalProps } from "./Modal";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar";
export { Sidebar } from "./Sidebar";
export { Skeleton, type SkeletonProps } from "./Skeleton";
export { StatCard, type StatCardProps } from "./StatCard";
export {
  showToast,
  Toast,
  type ToastDetail,
  type ToastKind,
} from "./Toast";
