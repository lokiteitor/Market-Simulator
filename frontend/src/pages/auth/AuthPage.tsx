/**
 * AuthPage — /auth (pública) [FE4].
 *
 * - Tabs Login / Registro (patrón WAI-ARIA tabs, flechas ←/→).
 * - Registro: selector de rol con descripción y color de cada rol
 *   (colores SOLO desde tokens.css) + validación client-side de
 *   username/password según el openapi (RegisterAgentRequest).
 * - Errores Problem (RFC 7807): `errors[].field` inline junto al campo;
 *   el resto (401 credenciales, 403 quiebra, red) en ErrorBanner.
 *   409 de registro → inline en username.
 * - Al éxito redirige a /dashboard; si ya hay sesión → /dashboard.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router";

import { ApiError } from "../../api/client";
import type { AgentRole, Problem } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { ErrorBanner, Field, Skeleton, type ProblemLike } from "../../components";
import { IconSprout } from "../../components/icons";
import { ROLE_INFOS } from "./roles";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  splitProblemByField,
  USERNAME_MAX,
  USERNAME_MIN,
  validatePassword,
  validateUsername,
} from "./validation";
import styles from "./AuthPage.module.css";

/** Campos del request que se mapean inline (login y registro). */
const AUTH_FIELDS = ["username", "password", "role"] as const;

type TabId = "login" | "register";

interface FieldErrors {
  username?: string;
  password?: string;
  role?: string;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export default function AuthPage() {
  const { status, login, register } = useAuth();
  const navigate = useNavigate();
  const baseId = useId();

  const [tab, setTab] = useState<TabId>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AgentRole | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<ProblemLike | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loginTabRef = useRef<HTMLButtonElement | null>(null);
  const registerTabRef = useRef<HTMLButtonElement | null>(null);

  // Sesión ya iniciada (o restaurada por el refresh silencioso) → dashboard.
  useEffect(() => {
    if (status === "authenticated") {
      navigate("/dashboard", { replace: true });
    }
  }, [status, navigate]);

  const switchTab = (next: TabId) => {
    setTab(next);
    setFieldErrors({});
    setGeneral(null);
  };

  // Patrón tabs: ←/→ mueven la selección y el foco.
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: TabId = tab === "login" ? "register" : "login";
    switchTab(next);
    (next === "login" ? loginTabRef : registerTabRef).current?.focus();
  };

  const applyError = (err: unknown, form: TabId) => {
    if (err instanceof ApiError) {
      const problem: Problem = err.problem;
      // 409 registro: username en uso → inline en el campo.
      if (form === "register" && err.status === 409) {
        setFieldErrors({
          username: problem.detail ?? "Ese nombre de usuario ya está en uso.",
        });
        return;
      }
      const { fields, general: rest } = splitProblemByField(problem, AUTH_FIELDS);
      setFieldErrors({
        username: fields["username"],
        password: fields["password"],
        role: fields["role"],
      });
      setGeneral(rest);
    } else {
      setGeneral({
        title: "No se pudo contactar con el servidor",
        detail: "Revisa tu conexión e inténtalo de nuevo.",
      });
    }
  };

  const submitLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const u = username.trim();
    const errs: FieldErrors = {};
    if (u === "") errs.username = "Escribe tu nombre de usuario.";
    if (password === "") errs.password = "Escribe tu contraseña.";
    if (errs.username !== undefined || errs.password !== undefined) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setGeneral(null);
    setSubmitting(true);
    try {
      await login(u, password);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      applyError(err, "login");
    } finally {
      setSubmitting(false);
    }
  };

  const submitRegister = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const u = username.trim();
    const errs: FieldErrors = {};
    const uErr = validateUsername(u);
    if (uErr !== null) errs.username = uErr;
    const pErr = validatePassword(password);
    if (pErr !== null) errs.password = pErr;
    if (role === null) errs.role = "Elige el rol de tu agente.";
    if (
      errs.username !== undefined ||
      errs.password !== undefined ||
      errs.role !== undefined
    ) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setGeneral(null);
    setSubmitting(true);
    try {
      await register({ username: u, password, role: role as AgentRole });
      navigate("/dashboard", { replace: true });
    } catch (err) {
      applyError(err, "register");
    } finally {
      setSubmitting(false);
    }
  };

  // Restaurando sesión (refresh silencioso al montar la app).
  if (status === "loading") {
    return (
      <div className={styles.page}>
        <div className={styles.card} aria-busy="true">
          <Skeleton rows={5} />
        </div>
      </div>
    );
  }

  // Autenticado: el useEffect ya está navegando a /dashboard.
  if (status === "authenticated") return null;

  const roleErrorId = `${baseId}-role-error`;

  return (
    <div className={styles.page}>
      <main className={styles.card}>
        <header className={styles.brand}>
          <span className={styles.brandIcon} aria-hidden="true">
            <IconSprout size={26} />
          </span>
          <div>
            <h1 className={styles.title}>Mercado Agrícola</h1>
            <p className={styles.subtitle}>
              Simulación de mercado en tiempo real. Entra con tu agente o crea
              uno nuevo.
            </p>
          </div>
        </header>

        <div
          className={styles.tabs}
          role="tablist"
          aria-label="Autenticación"
          onKeyDown={onTabsKeyDown}
        >
          <button
            type="button"
            role="tab"
            id={`${baseId}-tab-login`}
            aria-selected={tab === "login"}
            aria-controls={`${baseId}-panel-login`}
            tabIndex={tab === "login" ? 0 : -1}
            ref={loginTabRef}
            className={cx(styles.tab, tab === "login" && styles.tabActive)}
            onClick={() => switchTab("login")}
          >
            Entrar
          </button>
          <button
            type="button"
            role="tab"
            id={`${baseId}-tab-register`}
            aria-selected={tab === "register"}
            aria-controls={`${baseId}-panel-register`}
            tabIndex={tab === "register" ? 0 : -1}
            ref={registerTabRef}
            className={cx(styles.tab, tab === "register" && styles.tabActive)}
            onClick={() => switchTab("register")}
          >
            Crear agente
          </button>
        </div>

        {general !== null && (
          <div className={styles.banner}>
            <ErrorBanner problem={general} />
          </div>
        )}

        {tab === "login" ? (
          <form
            role="tabpanel"
            id={`${baseId}-panel-login`}
            aria-labelledby={`${baseId}-tab-login`}
            className={styles.form}
            onSubmit={(e) => void submitLogin(e)}
            noValidate
          >
            <Field label="Nombre de usuario" error={fieldErrors.username}>
              <input
                name="username"
                type="text"
                autoComplete="username"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field label="Contraseña" error={fieldErrors.password}>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <button type="submit" className={styles.submit} disabled={submitting}>
              {submitting ? "Entrando…" : "Entrar"}
            </button>
            <p className={styles.switchHint}>
              ¿Aún no tienes agente?{" "}
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => switchTab("register")}
              >
                Crea uno
              </button>
            </p>
          </form>
        ) : (
          <form
            role="tabpanel"
            id={`${baseId}-panel-register`}
            aria-labelledby={`${baseId}-tab-register`}
            className={styles.form}
            onSubmit={(e) => void submitRegister(e)}
            noValidate
          >
            <Field
              label="Nombre de usuario"
              hint={`De ${USERNAME_MIN} a ${USERNAME_MAX} caracteres: letras, números y . _ -`}
              error={fieldErrors.username}
            >
              <input
                name="username"
                type="text"
                autoComplete="username"
                spellCheck={false}
                maxLength={USERNAME_MAX}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field
              label="Contraseña"
              hint={`Mínimo ${PASSWORD_MIN} caracteres.`}
              error={fieldErrors.password}
            >
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                maxLength={PASSWORD_MAX}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </Field>

            <fieldset
              className={styles.roleFieldset}
              aria-describedby={fieldErrors.role ? roleErrorId : undefined}
            >
              <legend className={styles.roleLegend}>Rol del agente</legend>
              <p className={styles.roleHint}>
                Define tus capacidades productivas iniciales. Cualquier rol
                puede comprar y vender en el mercado.
              </p>
              <div className={styles.roleGrid}>
                {ROLE_INFOS.map((info) => {
                  const roleClass = {
                    transformer: styles.roleTransformer,
                    consumer: styles.roleConsumer,
                    trader: styles.roleTrader,
                    // admin/bank no aparecen en ROLE_INFOS; claves por exhaustividad de tipos.
                    admin: undefined,
                    bank: undefined,
                  }[info.role];
                  return (
                    <label
                      key={info.role}
                      className={cx(
                        styles.roleCard,
                        roleClass,
                        role === info.role && styles.roleCardChecked,
                      )}
                    >
                      <input
                        type="radio"
                        className={styles.roleInput}
                        name="role"
                        value={info.role}
                        checked={role === info.role}
                        onChange={() => {
                          setRole(info.role);
                          if (fieldErrors.role !== undefined) {
                            setFieldErrors((prev) => ({
                              ...prev,
                              role: undefined,
                            }));
                          }
                        }}
                        disabled={submitting}
                      />
                      <span className={styles.roleTop}>
                        <span className={styles.roleDot} aria-hidden="true" />
                        <span className={styles.roleName}>{info.label}</span>
                      </span>
                      <span className={styles.roleDesc}>{info.description}</span>
                    </label>
                  );
                })}
              </div>
              {fieldErrors.role !== undefined && (
                <p id={roleErrorId} className={styles.fieldError} role="alert">
                  {fieldErrors.role}
                </p>
              )}
            </fieldset>

            <button type="submit" className={styles.submit} disabled={submitting}>
              {submitting ? "Creando agente…" : "Crear agente"}
            </button>
            <p className={styles.switchHint}>
              ¿Ya tienes agente?{" "}
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => switchTab("login")}
              >
                Entra
              </button>
            </p>
          </form>
        )}

        <p className={styles.footNote}>
          El capital semilla se asigna al registrarte: el promedio del capital
          de los agentes activos en ese momento.
        </p>
      </main>
    </div>
  );
}
