/**
 * StartProcessModal [FE7] — Modal para iniciar un proceso de transformación
 * (design doc §4.3, POST /transformations).
 *
 * - Receta: solo las de tipos de instalación que el agente ha comprado
 *   (self-state), mostrando los huecos libres del tipo (level − running,
 *   presupuesto de concurrencia COMPARTIDO por las recetas del tipo, ADR-021).
 * - Ejecuciones: 1..N con preview de salario total upfront
 *   (rate × duración_sim × ejecuciones — ver transformMath.ts), insumos
 *   totales requeridos vs. inventario disponible (validación por fila) y
 *   duración/salida esperadas.
 * - Advertencia explícita: salario e insumos se pagan/consumen POR ADELANTADO
 *   y no se reembolsan al cancelar.
 * - Errores 422 mapeados por campo (recipe_id, executions_planned).
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../../api/client";
import type {
  InstallationStatus,
  InstallationType,
  Problem,
  Product,
  ProductCategory,
  Recipe,
  SelfState,
  StartTransformationRequest,
  TransformationProcess,
} from "../../api/types";
import { Badge, ErrorBanner, Field, Modal, showToast } from "../../components";
import { fmtMoney, fmtQty, truncId } from "../../lib/format";
import { splitProblemByField } from "../auth/validation";
import {
  PRODUCT_CATEGORY_LABEL,
  PRODUCT_CATEGORY_ORDER,
} from "../catalog/labels";
import {
  fmtDurationSeconds,
  realDurationSimHint,
} from "../market/simTime";
import {
  availableSlots,
  estimateWageCents,
  inputRequirements,
} from "./transformMath";
import styles from "./StartProcessModal.module.css";

export interface StartProcessModalProps {
  open: boolean;
  onClose: () => void;
}

/** Campos del request mapeables a errores inline (422 → errors[].field). */
const TRANSFORMATION_FIELDS = ["recipe_id", "executions_planned"] as const;

type FieldErrors = Partial<
  Record<(typeof TRANSFORMATION_FIELDS)[number], string>
>;

/** Error desconocido → Problem RFC 7807 mostrable en ErrorBanner. */
function toProblem(err: unknown): Problem {
  if (err instanceof ApiError) return err.problem;
  return {
    type: "about:blank",
    title: "Error de comunicación",
    status: 0,
    detail: err instanceof Error ? err.message : "Fallo de red desconocido.",
  };
}

export function StartProcessModal({ open, onClose }: StartProcessModalProps) {
  const queryClient = useQueryClient();

  // ---- Datos (caché compartida con el resto de la app) -----------------------
  const selfQuery = useQuery({
    queryKey: ["self"],
    queryFn: ({ signal }) => api.get<SelfState>("/agents/me", { signal }),
  });
  const recipesQuery = useQuery({
    queryKey: ["catalog", "recipes"],
    queryFn: ({ signal }) =>
      api.get<Recipe[]>("/catalog/recipes", { signal, auth: false }),
    staleTime: Infinity,
  });
  const productsQuery = useQuery({
    queryKey: ["catalog", "products"],
    queryFn: ({ signal }) =>
      api.get<Product[]>("/catalog/products", { signal, auth: false }),
    staleTime: Infinity,
  });

  // Catálogo de tipos de instalación: para mapear recipe.installation_type_id
  // (UUID de la receta) → key del tipo (que es lo que expone self.installations).
  const installationTypesQuery = useQuery({
    queryKey: ["catalog", "installation-types"],
    queryFn: ({ signal }) =>
      api.get<InstallationType[]>("/catalog/installation-types", {
        signal,
        auth: false,
      }),
    staleTime: Infinity,
  });

  const self = selfQuery.data ?? null;
  const bankrupt = self !== null && self.agent.status === "bankrupt";
  const installations = self?.installations ?? [];

  const recipeById = useMemo(() => {
    const map = new Map<string, Recipe>();
    for (const r of recipesQuery.data ?? []) map.set(r.recipe_id, r);
    return map;
  }, [recipesQuery.data]);

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of productsQuery.data ?? []) map.set(p.product_id, p);
    return map;
  }, [productsQuery.data]);

  const productName = (productId: string): string =>
    productById.get(productId)?.name ?? truncId(productId);
  const productUnit = (productId: string): string | undefined =>
    productById.get(productId)?.unit;

  // installation_type_id (UUID) → key del tipo.
  const typeKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of installationTypesQuery.data ?? [])
      map.set(t.installation_type_id, t.key);
    return map;
  }, [installationTypesQuery.data]);

  // key del tipo → instalación comprada por el agente (nivel + huecos).
  const ownedByTypeKey = useMemo(() => {
    const map = new Map<string, InstallationStatus>();
    for (const i of installations) map.set(i.installation_type, i);
    return map;
  }, [installations]);

  /** Instalación comprada que habilita la receta (o undefined si no la tiene). */
  const installationForRecipe = (
    recipe: Recipe | undefined,
  ): InstallationStatus | undefined => {
    if (recipe === undefined) return undefined;
    const key = typeKeyById.get(recipe.installation_type_id);
    return key === undefined ? undefined : ownedByTypeKey.get(key);
  };

  // Recetas ejecutables (de tipos comprados) agrupadas por la categoría del
  // producto de salida (espejo del selector de MarketPage).
  const recipeGroups = useMemo(() => {
    const runnable = (recipesQuery.data ?? []).filter((r) => {
      const key = typeKeyById.get(r.installation_type_id);
      return key !== undefined && ownedByTypeKey.has(key);
    });
    const byCategory = new Map<ProductCategory, Recipe[]>();
    const other: Recipe[] = [];
    for (const r of runnable) {
      const category = productById.get(r.output_product_id)?.category;
      if (category === undefined) {
        other.push(r);
      } else {
        const list = byCategory.get(category);
        if (list === undefined) byCategory.set(category, [r]);
        else list.push(r);
      }
    }
    const sortByName = (list: Recipe[]): Recipe[] =>
      [...list].sort((a, b) => a.name.localeCompare(b.name, "es"));
    const groups: Array<{ label: string; items: Recipe[] }> = [];
    for (const category of PRODUCT_CATEGORY_ORDER) {
      const list = byCategory.get(category);
      if (list && list.length > 0) {
        groups.push({
          label: PRODUCT_CATEGORY_LABEL[category],
          items: sortByName(list),
        });
      }
    }
    if (other.length > 0) {
      groups.push({ label: "Otras", items: sortByName(other) });
    }
    return groups;
  }, [recipesQuery.data, typeKeyById, ownedByTypeKey, productById]);

  // ---- Estado del formulario ---------------------------------------------------
  const [recipeId, setRecipeId] = useState("");
  const [executionsText, setExecutionsText] = useState("1");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [domainError, setDomainError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Problem | null>(null);

  useEffect(() => {
    if (!open) return;
    setRecipeId("");
    setExecutionsText("1");
    setFieldErrors({});
    setDomainError(null);
    setBanner(null);
  }, [open]);

  // ---- Derivados / preview --------------------------------------------------------
  const recipe = recipeById.get(recipeId) ?? null;
  const installation = installationForRecipe(recipe ?? undefined) ?? null;
  const executions = useMemo(() => {
    const text = executionsText.trim();
    if (!/^\d+$/.test(text)) return null;
    const n = Number.parseInt(text, 10);
    return Number.isSafeInteger(n) ? n : null;
  }, [executionsText]);

  const preview = useMemo(() => {
    if (recipe === null || executions === null || executions < 1) return null;
    const wageCents = estimateWageCents(recipe, executions);
    const inputs = inputRequirements(
      recipe,
      executions,
      self?.inventory ?? [],
    );
    return {
      wageCents,
      inputs,
      totalDurationSeconds: recipe.duration_seconds * executions,
      outputQtyCent: recipe.output_qty_cent * executions,
    };
  }, [recipe, executions, self]);

  // ---- Validación client-side --------------------------------------------------------
  const validate = (): StartTransformationRequest | null => {
    const errors: FieldErrors = {};
    let domain: string | null = null;

    if (recipeId === "") {
      errors.recipe_id = "Selecciona una receta.";
    } else if (installation === null) {
      errors.recipe_id =
        "No tienes una instalación comprada para esta receta.";
    } else if (availableSlots(installation) < 1) {
      errors.recipe_id = `Instalación saturada: ${installation.running}/${installation.level} procesos del tipo en curso.`;
    }

    if (executions === null || executions < 1) {
      errors.executions_planned =
        "Indica un número entero de ejecuciones (mínimo 1).";
    }

    if (recipe !== null && preview !== null && self !== null) {
      const missing = preview.inputs.filter((i) => !i.ok);
      if (missing.length > 0) {
        domain =
          "Insumos insuficientes: " +
          missing
            .map(
              (i) =>
                `${productName(i.productId)} (requiere ${fmtQty(
                  i.requiredCent,
                  productUnit(i.productId),
                )}, tienes ${fmtQty(i.availableCent, productUnit(i.productId))})`,
            )
            .join("; ") +
          ".";
      } else if (preview.wageCents > self.capital_available_cents) {
        domain =
          `Capital insuficiente: el salario upfront es ` +
          `${fmtMoney(preview.wageCents)} y tienes ` +
          `${fmtMoney(self.capital_available_cents)} disponibles.`;
      }
    }

    setFieldErrors(errors);
    setDomainError(domain);
    if (
      Object.keys(errors).length > 0 ||
      domain !== null ||
      executions === null
    ) {
      return null;
    }
    return { recipe_id: recipeId, executions_planned: executions };
  };

  // ---- Envío ------------------------------------------------------------------------
  const startProcess = useMutation({
    mutationFn: (req: StartTransformationRequest) =>
      api.post<TransformationProcess>("/transformations", req),
    onSuccess: (res) => {
      const name = recipeById.get(res.recipe_id)?.name ?? truncId(res.recipe_id);
      showToast({
        kind: "success",
        title: "Proceso iniciado",
        body: `${name} × ${res.executions_planned} — salario pagado ${fmtMoney(res.wage_paid_cents)}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["self"] });
      void queryClient.invalidateQueries({ queryKey: ["processes"] });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        const { fields, general } = splitProblemByField(
          err.problem,
          TRANSFORMATION_FIELDS,
        );
        setFieldErrors(fields as FieldErrors);
        setBanner(general);
      } else {
        setBanner(toProblem(err));
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBanner(null);
    const req = validate();
    if (req === null) return;
    startProcess.mutate(req);
  };

  const close = () => {
    if (!startProcess.isPending) onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Iniciar proceso de transformación">
      <form className={styles["form"]} onSubmit={submit} noValidate>
        {bankrupt && (
          <ErrorBanner
            problem={{
              title: "Agente en quiebra",
              detail:
                "No puedes iniciar procesos: el agente salió del mercado.",
            }}
          />
        )}

        <Field
          label="Receta"
          error={fieldErrors.recipe_id ?? null}
          hint={
            installations.length === 0
              ? "No tienes ninguna instalación comprada; compra una para producir."
              : undefined
          }
        >
          <select
            value={recipeId}
            onChange={(e) => setRecipeId(e.target.value)}
            disabled={recipesQuery.isPending || installations.length === 0}
          >
            <option value="">
              {recipesQuery.isPending
                ? "Cargando recetas…"
                : "Selecciona una receta"}
            </option>
            {recipeGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((r) => {
                  const inst = installationForRecipe(r);
                  const slots = inst ? availableSlots(inst) : 0;
                  const level = inst?.level ?? 0;
                  return (
                    <option key={r.recipe_id} value={r.recipe_id}>
                      {r.name} — {slots}/{level}{" "}
                      {slots === 1 ? "hueco libre" : "huecos libres"}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
        </Field>

        <Field
          label="Ejecuciones planificadas"
          error={fieldErrors.executions_planned ?? null}
          hint={
            recipe !== null
              ? `Cada ejecución produce ${fmtQty(
                  recipe.output_qty_cent,
                  productUnit(recipe.output_product_id),
                )} de ${productName(recipe.output_product_id)} y dura ${fmtDurationSeconds(recipe.duration_seconds)} reales.`
              : undefined
          }
        >
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={executionsText}
            onChange={(e) => setExecutionsText(e.target.value)}
          />
        </Field>

        {/* Vista previa del proceso */}
        {recipe !== null && preview !== null && (
          <div className={styles["preview"]}>
            <dl className={styles["previewList"]}>
              <dt>Salario total (pago upfront)</dt>
              <dd className={styles["mono"]}>{fmtMoney(preview.wageCents)}</dd>
              <dt>Capital disponible</dt>
              <dd className={styles["mono"]}>
                {self !== null
                  ? fmtMoney(self.capital_available_cents)
                  : "…"}
              </dd>
              <dt>Duración total</dt>
              <dd>
                <span className={styles["mono"]}>
                  {fmtDurationSeconds(preview.totalDurationSeconds)}
                </span>{" "}
                <span className={styles["subtle"]}>
                  {realDurationSimHint(preview.totalDurationSeconds)}
                </span>
              </dd>
              <dt>Salida esperada</dt>
              <dd className={styles["mono"]}>
                {fmtQty(
                  preview.outputQtyCent,
                  productUnit(recipe.output_product_id),
                )}{" "}
                de {productName(recipe.output_product_id)}
              </dd>
            </dl>

            <h3 className={styles["inputsTitle"]}>Insumos requeridos</h3>
            {preview.inputs.length === 0 ? (
              <p className={styles["subtle"]}>
                Sin insumos: receta de producción primaria.
              </p>
            ) : (
              <table className={styles["inputsTable"]}>
                <caption className="visually-hidden">
                  Insumos requeridos frente a inventario disponible
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Insumo</th>
                    <th scope="col" className={styles["num"]}>
                      Requerido
                    </th>
                    <th scope="col" className={styles["num"]}>
                      Disponible
                    </th>
                    <th scope="col"> </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.inputs.map((input) => (
                    <tr key={input.productId}>
                      <td>{productName(input.productId)}</td>
                      <td className={`${styles["num"]} ${styles["mono"]}`}>
                        {fmtQty(
                          input.requiredCent,
                          productUnit(input.productId),
                        )}
                      </td>
                      <td className={`${styles["num"]} ${styles["mono"]}`}>
                        {fmtQty(
                          input.availableCent,
                          productUnit(input.productId),
                        )}
                      </td>
                      <td>
                        {input.ok ? (
                          <Badge kind="active">OK</Badge>
                        ) : (
                          <Badge kind="bankrupt">Falta</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Advertencia upfront (design doc §4.3) */}
        <div className={styles["warnBox"]}>
          <strong>Pago por adelantado.</strong> Al iniciar, el salario completo
          se paga upfront y los insumos se consumen inmediatamente (FIFO por
          lote). Si luego cancelas el proceso, <strong>no hay reembolso</strong>{" "}
          de salario ni de insumos.
        </div>

        {domainError !== null && (
          <p className={styles["domainError"]} role="alert">
            {domainError}
          </p>
        )}

        {banner !== null && <ErrorBanner problem={banner} />}

        <div className={styles["actions"]}>
          <button
            type="button"
            className={`${styles["btn"]} ${styles["btnSecondary"]}`}
            onClick={close}
            disabled={startProcess.isPending}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className={`${styles["btn"]} ${styles["btnPrimary"]}`}
            disabled={
              startProcess.isPending || bankrupt || installations.length === 0
            }
          >
            {startProcess.isPending ? "Iniciando…" : "Iniciar proceso"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
