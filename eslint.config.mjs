import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...nextVitals,
  // FASE-02: Security rules (strict everywhere)
  {
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  // Relaxed rules for open-sse and tests (incremental adoption)
  {
    files: ["open-sse/**/*.ts", "tests/**/*.mjs", "tests/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@next/next/no-assign-module-variable": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
  // Global ignores (open-sse and tests REMOVED — now linted)
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "scripts/**",
      "bin/**",
      "node_modules/**",
    ],
  },
];

export default eslintConfig;
