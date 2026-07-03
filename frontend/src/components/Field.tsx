/**
 * Field — envoltorio accesible de un control de formulario:
 * label explícito (htmlFor), hint y error enlazados vía aria-describedby,
 * y aria-invalid cuando hay error (errores 422 mapeados por campo).
 *
 * El hijo debe ser UN único control (input/select/textarea…); Field le
 * inyecta id y atributos aria vía cloneElement (respeta un id propio si
 * el control ya lo trae).
 */
import { cloneElement, useId, type ReactElement } from "react";

import styles from "./Field.module.css";

interface InjectedControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

export interface FieldProps {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactElement<InjectedControlProps>;
}

export function Field({ label, error, hint, children }: FieldProps) {
  const autoId = useId();
  const controlId = children.props.id ?? autoId;
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;

  const describedBy =
    [
      children.props["aria-describedby"],
      hint ? hintId : undefined,
      error ? errorId : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  const control = cloneElement(children, {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  });

  return (
    <div className={styles["field"]}>
      <label className={styles["label"]} htmlFor={controlId}>
        {label}
      </label>
      <div className={error ? styles["controlError"] : undefined}>
        {control}
      </div>
      {hint && (
        <p id={hintId} className={styles["hint"]}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles["error"]}>
          {error}
        </p>
      )}
    </div>
  );
}
