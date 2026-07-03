// Flat config minimal (ESLint 10 + typescript-eslint).
// El estilo lo gobierna Prettier; aquí solo reglas de corrección básicas.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "src/db/migrations/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Logs con pino (src/observability/logger.ts); nunca console.log en src/.
      "no-console": "error",
    },
  },
);
