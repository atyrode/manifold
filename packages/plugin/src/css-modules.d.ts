/**
 * THE BUNDLER CONTRACT FOR STYLESHEETS, declared once.
 *
 * `import "./styles.css";` is how a plugin's web half ships its own skin: vite sees the edge,
 * emits the rules into the built CSS, and the sheet arrives with the code that paints against
 * it. TypeScript needs to be told that such a specifier resolves at all, and the declaration
 * has to be a MODULE with no exports rather than the shorthand form — the shorthand types
 * every import from it as `any`, and this tree does not have an `any` in it.
 *
 * It lives here, in the one package every plugin already depends on, because nine copies of
 * the same two lines is nine doors onto one fact (invariant 14). Packages that need it name
 * this file in their tsconfig `include`; `packages/web` does not, because `vite/client`
 * already declares the same thing for the bundled entry.
 */
declare module "*.css" {}
