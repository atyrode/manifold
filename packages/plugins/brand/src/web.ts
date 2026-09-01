/**
 * `core.brand`, browser half — the one row this seat contributes.
 *
 * `packages/web/src/assembly.ts` is still the one file that ATTACHES this component to the
 * manifest id the server's roster published; nothing here knows it is being registered. The
 * panel that stacks the rail's rows does not import `BrandRow` directly either — it asks the
 * projection registry for the component behind the `brand` section id, so this row arrives by
 * exactly the route a stranger's row does, and `core.brand` has no privileged path into the
 * sidebar it draws inside.
 */
export { BrandRow } from "./brand-row.tsx";
