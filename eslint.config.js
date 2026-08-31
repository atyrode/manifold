import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.types/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: [
      "packages/web/**/*.{ts,tsx}",
      "packages/plugin/**/*.{ts,tsx}",
      "packages/plugins/**/*.{ts,tsx}",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
