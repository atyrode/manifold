/**
 * Browser-only action-plane UI shared by sibling plugins. Kept behind its own package subpath
 * so server composition never imports React, the DOM, rjsf, or its validator.
 */
export { actionSummary } from "./action-summary.ts";
export { DoorForm, type DoorFormProps } from "./door-form.tsx";
