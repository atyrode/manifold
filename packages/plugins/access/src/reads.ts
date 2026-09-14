import type { SectionProps } from "@manifold/plugin";
import { FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { z } from "zod";
import { accessManifest } from "./index.ts";

export type AccessRead<T> =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "ready"; readonly result: T; readonly observedAt: number };

const LOADING = { state: "loading" } as const;

/** Event refresh uses the shared feed, but privileged answers never share an authority cache. */
export function useAccessRead<T>(
  host: SectionProps["host"],
  action: string,
  schema: z.ZodType<T>,
  args: Readonly<Record<string, unknown>>,
  revision = 0,
): AccessRead<T> {
  const readerId = useId();
  const request = JSON.stringify(args);
  const [scope, setScope] = useState({
    client: host.client,
    viewer: host.principal.id,
    request,
    action,
    schema,
    generation: 0,
  });
  const sameScope =
    scope.client === host.client &&
    scope.viewer === host.principal.id &&
    scope.request === request &&
    scope.action === action &&
    scope.schema === schema;
  const generation = scope.generation + (sameScope ? 0 : 1);
  if (!sameScope)
    setScope({
      client: host.client,
      viewer: host.principal.id,
      request,
      action,
      schema,
      generation,
    });
  const fetchRead = useCallback(async (): Promise<AccessRead<T>> => {
    try {
      const input: unknown = JSON.parse(request);
      const outcome = await host.client.action(action, input);
      if (!outcome.ok) return { state: "failed", message: outcome.denial.message };
      const parsed = schema.safeParse(outcome.result);
      return parsed.success
        ? { state: "ready", result: parsed.data, observedAt: Date.now() }
        : { state: "failed", message: "The Access response could not be read." };
    } catch (reason: unknown) {
      return {
        state: "failed",
        message: reason instanceof Error ? reason.message : "The Access request failed.",
      };
    }
  }, [host.client, action, request, schema]);
  const { value, refresh } = usePolledResource<AccessRead<T>>(fetchRead, FALLBACK_POLL_MS, {
    key: `${action}:${readerId}`,
    restartKey: `${String(generation)}:${request}`,
    initial: LOADING,
    topics: [{ kind: "plugin", pluginId: accessManifest.id }],
    events: host.client,
  });
  const observedRevision = useRef(revision);
  useEffect(() => {
    if (observedRevision.current === revision) return;
    observedRevision.current = revision;
    refresh();
  }, [revision, refresh]);
  // A→B→A gets a new feed generation, and a changed authority cannot paint even one old frame.
  return sameScope ? value : LOADING;
}
