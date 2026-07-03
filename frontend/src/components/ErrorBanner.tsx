/**
 * ErrorBanner — banner de error a partir de un Problem (RFC 7807 + errors[]):
 * título + detail + lista de causas. role="alert" para anuncio inmediato.
 *
 * `Problem` se tipa aquí de forma ESTRUCTURAL (todos los campos opcionales
 * salvo message dentro de errors[]) para que el `Problem` de src/api sea
 * asignable sin acoplar este componente a la capa de datos.
 */
import { IconAlert } from "./icons";
import styles from "./ErrorBanner.module.css";

export interface ProblemErrorItem {
  code?: string;
  field?: string | null;
  message: string;
}

export interface ProblemLike {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  errors?: ReadonlyArray<ProblemErrorItem>;
}

export interface ErrorBannerProps {
  problem: ProblemLike;
}

export function ErrorBanner({ problem }: ErrorBannerProps) {
  const title = problem.title?.trim() || "Se produjo un error";
  const errors = problem.errors ?? [];

  return (
    <div className={styles["banner"]} role="alert">
      <span className={styles["icon"]}>
        <IconAlert size={20} />
      </span>
      <div className={styles["body"]}>
        <p className={styles["title"]}>
          {title}
          {problem.status !== undefined && (
            <span className={styles["status"]}> ({problem.status})</span>
          )}
        </p>
        {problem.detail && <p className={styles["detail"]}>{problem.detail}</p>}
        {errors.length > 0 && (
          <ul className={styles["list"]}>
            {errors.map((e, i) => (
              <li key={i}>
                {e.field ? (
                  <>
                    <code className={styles["fieldName"]}>{e.field}</code>
                    {": "}
                  </>
                ) : null}
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
