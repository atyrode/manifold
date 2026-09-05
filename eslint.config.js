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
  {
    /*
      The app shell's cache is a SERVICE WORKER: plain JS on purpose (it is shipped verbatim by
      the build, not compiled), so it gets neither the DOM globals of a browser file nor TypeScript's
      lib resolution. Its globals are declared here rather than pulled from a `globals` package —
      six names is not a dependency.
    */
    files: ["packages/web/sw.js"],
    languageOptions: {
      globals: {
        Request: "readonly",
        URL: "readonly",
        caches: "readonly",
        fetch: "readonly",
        self: "readonly",
      },
    },
  },
  {
    /*
      The isolate runner's fixture guests are plain JS for the same reason: the supervisor
      spawns `server.js` from a bundle directory verbatim, so the child side of the protocol is
      written by hand in the file it runs from. One global is the whole child runtime.
    */
    files: ["packages/server/test/fixtures/isolate-guest*/server.js"],
    languageOptions: { globals: { process: "readonly" } },
  },
);
