// Flat config minimal (ESLint 10 + typescript-eslint).
// El estilo lo gobierna Prettier; aquí solo reglas de corrección básicas.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", "src/db/migrations/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Convención: argumentos/variables intencionalmente sin uso llevan prefijo _.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // Logs con pino (src/observability/logger.ts); nunca console.log en src/.
      "no-console": "error",
    },
  },
);
