import { Suspense, lazy, type ReactElement } from "react";

import type { HostServices } from "../host.ts";

export interface DoorFormProps {
  /** The full name of an action in the host's composed protocol document. */
  readonly action: string;
  readonly host: HostServices;
}

const LazyDoorFormEngine = lazy(() =>
  import("./door-form-engine.tsx").then((module) => ({ default: module.DoorFormEngine })),
);

/**
 * The shared browser action form. Its lightweight wrapper is safe in the host's shared-module
 * registry; rjsf, Ajv, and the form skin remain behind this internal lazy boundary.
 */
export function DoorForm(props: DoorFormProps): ReactElement {
  return (
    <Suspense fallback={<p className="door-form__loading">loading the form engine…</p>}>
      <LazyDoorFormEngine key={props.action} {...props} />
    </Suspense>
  );
}
