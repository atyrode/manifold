import type { SectionProps } from "@manifold/plugin";
import { FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import {
  canonicalJobJson,
  InspectJobInvocationsResultSchema,
  JobInvocationEdgeSchema,
  type InspectJobInvocationsResult,
  type JobInvocationCandidate,
  type JobInvocationEdge,
} from "@manifold/protocol";
import { Cluster, Stack } from "@manifold/ui";
import { useState, type ReactElement } from "react";

type Host = SectionProps["host"];
const JOBS_TOPIC = { kind: "plugin", pluginId: "engine.jobs" } as const;
const limits = [
  { key: "timeoutMs", label: "Aggregate timeout (ms)", max: 86400000 },
  { key: "memoryBytes", label: "Aggregate memory (bytes)", max: 1099511627776 },
  { key: "processes", label: "Aggregate processes", max: 4096 },
  { key: "outputBytes", label: "Aggregate output (bytes)", max: 1073741824 },
] as const;

async function request(host: Host, action: string, args: unknown): Promise<unknown> {
  const outcome = await host.client.action(action, args);
  if (!outcome.ok) throw new Error(outcome.denial.message);
  if (typeof outcome.result === "object" && outcome.result !== null && "refused" in outcome.result)
    throw new Error(
      typeof outcome.result.refused === "string" ? outcome.result.refused : "Request refused",
    );
  return outcome.result;
}
function sameTargets(edge: JobInvocationEdge, candidate: JobInvocationCandidate): boolean {
  return (
    canonicalJobJson(edge.caller) === canonicalJobJson(candidate.caller) &&
    canonicalJobJson(edge.callee) === canonicalJobJson(candidate.callee) &&
    canonicalJobJson(edge.resources) === canonicalJobJson(candidate.resources)
  );
}
function Target({
  label,
  target,
}: {
  readonly label: string;
  readonly target: JobInvocationEdge["caller"];
}): ReactElement {
  return (
    <div className="plugin-manager-runtime-location">
      <strong>
        {label}: {target.pluginId} / {target.operationId}
      </strong>
      <small>Machine: {target.machineId}</small>
      <small>Installation: {target.installationRevision}</small>
      <small>Artifact SHA-256: {target.artifactSha256}</small>
    </div>
  );
}
function EdgeReview({ edge }: { readonly edge: JobInvocationEdge }): ReactElement {
  return (
    <>
      <Target label="Caller" target={edge.caller} />
      <Target label="Callee" target={edge.callee} />
      <small>
        Maximum depth: {edge.maxDepth} · Maximum concurrency: {edge.maxConcurrency}
      </small>
      {limits.map((limit) => (
        <small key={limit.key}>
          {limit.label}: {edge.aggregate[limit.key]}
        </small>
      ))}
      <details>
        <summary>Exact location access and output grants</summary>
        <pre>{JSON.stringify({ resources: edge.resources, outputs: edge.outputs }, null, 2)}</pre>
      </details>
    </>
  );
}

function ApprovalForm({
  candidate,
  existing,
  disabled,
  onApprove,
}: {
  readonly candidate: JobInvocationCandidate;
  readonly existing: JobInvocationEdge | undefined;
  readonly disabled: boolean;
  readonly onApprove: (edge: JobInvocationEdge) => Promise<void>;
}): ReactElement {
  const [bounds, setBounds] = useState<Record<string, string>>(() =>
    existing
      ? {
          maxDepth: String(existing.maxDepth),
          maxConcurrency: String(existing.maxConcurrency),
          ...Object.fromEntries(
            limits.map((limit) => [limit.key, String(existing.aggregate[limit.key])]),
          ),
        }
      : {},
  );
  const [outputs, setOutputs] = useState<
    Record<string, { locationId: string; path: string; suffix: string }>
  >(() =>
    Object.fromEntries(
      (existing?.outputs ?? []).map((output) => [
        output.name,
        {
          locationId: output.locationId,
          path: output.components.join("/"),
          suffix: String(output.maxSuffixComponents),
        },
      ]),
    ),
  );
  const [reviewed, setReviewed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    if (disabled || !reviewed) return;
    const parsed = JobInvocationEdgeSchema.safeParse({
      caller: candidate.caller,
      callee: candidate.callee,
      resources: candidate.resources,
      maxDepth: Number(bounds.maxDepth ?? ""),
      maxConcurrency: Number(bounds.maxConcurrency ?? ""),
      aggregate: Object.fromEntries(
        limits.map((limit) => [limit.key, Number(bounds[limit.key] ?? "")]),
      ),
      outputs: candidate.outputNames.flatMap((name) => {
        const value = outputs[name];
        return value?.locationId
          ? [
              {
                name,
                locationId: value.locationId,
                components: value.path.split("/"),
                maxSuffixComponents: value.suffix === "" ? -1 : Number(value.suffix),
              },
            ]
          : [];
      }),
    });
    if (!parsed.success) {
      setFailure(
        "Enter positive bounded integer limits and valid output paths with explicit suffix bounds (0–16 components; 16 total). At most 30 output grants are allowed.",
      );
      return;
    }
    setFailure(null);
    await onApprove(parsed.data);
  };
  return (
    <form
      className="plugin-manager-runtime-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h5>Review exact runtime edge</h5>
      <small>
        Service {candidate.serviceId} · revision {candidate.revision} · operations{" "}
        {candidate.operationIds.join(", ")}
      </small>
      <small>Service policy SHA-256: {candidate.policySha256}</small>
      <Target label="Caller" target={candidate.caller} />
      <Target label="Callee" target={candidate.callee} />
      <details>
        <summary>Declared limits and exact resource locations</summary>
        <pre>
          {JSON.stringify(
            {
              callerLimits: candidate.callerLimits,
              calleeLimits: candidate.calleeLimits,
              resources: candidate.resources,
              locations: candidate.locations,
              outputLocations: candidate.outputLocations,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <p className="plugin-manager-sheet-muted">
        These aggregate ceilings bound the invocation tree, not a single operation. No limits or
        output grants are approved automatically.
      </p>
      {[
        { key: "maxDepth", label: "Maximum invocation depth", max: 64 },
        { key: "maxConcurrency", label: "Maximum concurrent invocations", max: 4096 },
        ...limits,
      ].map((bound) => (
        <label className="plugin-manager-install-field" key={bound.key}>
          <span>
            {bound.label} · 1–{bound.max}
          </span>
          <input
            type="number"
            min={1}
            max={bound.max}
            step={1}
            required
            disabled={disabled}
            aria-label={`${candidate.serviceId} ${bound.label}`}
            value={bounds[bound.key] ?? ""}
            onChange={(event) => {
              setReviewed(false);
              setBounds((current) => ({ ...current, [bound.key]: event.target.value }));
            }}
          />
        </label>
      ))}
      <h5>Optional output grants into caller locations</h5>
      <p className="plugin-manager-sheet-muted">
        No selection means no output grant. Paths are relative to the selected caller location;
        suffix bounds limit additional path components.
      </p>
      {candidate.outputNames.map((name) => {
        const output = outputs[name] ?? { locationId: "", path: "", suffix: "" };
        const update = (field: keyof typeof output, value: string): void => {
          setReviewed(false);
          setOutputs((current) => ({ ...current, [name]: { ...output, [field]: value } }));
        };
        return (
          <div key={name} className="plugin-manager-runtime-location">
            <label className="plugin-manager-install-field">
              <span>{name} · caller output location</span>
              <select
                aria-label={`${name} caller output location`}
                disabled={disabled}
                value={output.locationId}
                onChange={(event) => update("locationId", event.target.value)}
              >
                <option value="">No grant</option>
                {Object.keys(candidate.outputLocations).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            {output.locationId ? (
              <>
                <label className="plugin-manager-install-field">
                  <span>Relative output path</span>
                  <input
                    aria-label={`${name} output path`}
                    value={output.path}
                    required
                    disabled={disabled}
                    onChange={(event) => update("path", event.target.value)}
                  />
                </label>
                <label className="plugin-manager-install-field">
                  <span>Maximum additional path components · 0–16</span>
                  <input
                    aria-label={`${name} maximum suffix components`}
                    type="number"
                    min={0}
                    max={16}
                    step={1}
                    value={output.suffix}
                    required
                    disabled={disabled}
                    onChange={(event) => update("suffix", event.target.value)}
                  />
                </label>
              </>
            ) : null}
          </div>
        );
      })}
      <label className="plugin-manager-install-field">
        <span>
          <input
            type="checkbox"
            checked={reviewed}
            disabled={disabled}
            onChange={(event) => setReviewed(event.target.checked)}
          />{" "}
          I reviewed these exact installation pins, resource access, output grants and aggregate
          limits.
        </span>
      </label>
      {failure ? (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      ) : null}
      <button
        type="submit"
        className="plugin-manager-filter"
        disabled={disabled || !reviewed}
        data-action="engine.jobs.setInvocationEdge"
      >
        Approve exact invocation edge
      </button>
    </form>
  );
}

/** Root-only inspection and explicit decisions; mounting performs reads only. */
export function RuntimeInvocations({
  host,
  machineId,
  pluginId,
}: {
  readonly host: Host;
  readonly machineId: string;
  readonly pluginId: string;
}): ReactElement {
  const canApprove = host.client.selfCaps().includes("*");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { value: observation, refresh } = usePolledResource<{
    value: InspectJobInvocationsResult | null;
    failure: string | null;
  } | null>(
    async () => {
      if (!canApprove) return null;
      try {
        const value = InspectJobInvocationsResultSchema.parse(
          await request(host, "engine.jobs.inspectInvocations", { machineId, pluginId }),
        );
        if (value.machineId !== machineId || value.pluginId !== pluginId)
          throw new Error("Invocation response does not match this machine and plugin");
        return { value, failure: null };
      } catch (error) {
        return {
          value: null,
          failure: error instanceof Error ? error.message : "Invocation inspection unavailable",
        };
      }
    },
    FALLBACK_POLL_MS,
    {
      key: `engine.jobs.inspectInvocations:${machineId}:${pluginId}:${canApprove}`,
      initial: null,
      topics: [...host.topics.machines, JOBS_TOPIC],
      events: host.client,
    },
  );
  const inspection = observation?.value;
  const decide = async (edge: JobInvocationEdge, enabled: boolean): Promise<void> => {
    if (!canApprove || pending) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await request(host, "engine.jobs.setInvocationEdge", { edge, enabled });
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result) ||
        Object.keys(result).length !== 0
      )
        throw new Error("Invocation decision acknowledgement could not be read");
      setNotice(
        enabled
          ? "Exact invocation edge approved. Ordinary consents and runtime readiness are still checked independently."
          : "Invocation edge revoked.",
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Invocation decision unavailable");
    } finally {
      await refresh();
      setPending(false);
    }
  };
  return (
    <Stack gap="0.6rem" className="plugin-manager-runtime-operation">
      <h5>Service-runtime invocation edges</h5>
      <p className="plugin-manager-sheet-muted">
        Edge approval is separate from ordinary location, operation and service consents. It permits
        only the reviewed caller to invoke the exact callee under bounded resources and limits.
        Changed installation or artifact pins require explicit new approval.
      </p>
      {!canApprove ? (
        <p className="plugin-manager-sheet-muted">
          Only an administrator can inspect or approve invocation edges.
        </p>
      ) : (
        <>
          <Cluster gap="0.4rem">
            <button
              type="button"
              className="plugin-manager-filter"
              disabled={pending}
              onClick={() => void refresh()}
            >
              Refresh invocation edges
            </button>
          </Cluster>
          {observation?.failure ? (
            <p className="plugin-manager-error" role="alert">
              {observation.failure}
            </p>
          ) : null}
          {!observation ? (
            <p className="plugin-manager-sheet-muted">Reading current invocation policy…</p>
          ) : null}
          {inspection?.unavailable.map((row) => (
            <p className="plugin-manager-error" key={`${row.caller.operationId}:${row.serviceId}`}>
              {row.caller.operationId} → {row.serviceId}@{row.revision}: {row.reason}. Update the
              native binding or runtime policy before reviewing an edge.
            </p>
          ))}
          <h5>Configured edges, including previous installation pins</h5>
          {inspection?.edges.map(({ edge, enabled }) => {
            const current = inspection.candidates.some((candidate) => sameTargets(edge, candidate));
            return (
              <section
                className="plugin-manager-runtime-location"
                key={`${canonicalJobJson(edge.caller)}:${edge.callee.operationId}`}
              >
                <strong>
                  {enabled ? "Approved" : "Revoked"} ·{" "}
                  {current
                    ? "matches a current runtime candidate"
                    : "not a current runtime candidate; not reusable for changed pins"}
                </strong>
                <EdgeReview edge={edge} />
                <button
                  type="button"
                  className="plugin-manager-filter"
                  data-action="engine.jobs.setInvocationEdge"
                  disabled={pending || !enabled}
                  onClick={() => void decide(edge, false)}
                >
                  Revoke exact invocation edge
                </button>
              </section>
            );
          })}
          {inspection?.edges.length === 0 ? (
            <p className="plugin-manager-sheet-muted">No configured invocation edges.</p>
          ) : null}
          {inspection?.candidates.map((candidate) => {
            const configured = inspection.edges.find((row) => sameTargets(row.edge, candidate));
            return (
              <ApprovalForm
                key={canonicalJobJson({ candidate, configured })}
                candidate={candidate}
                existing={configured?.edge}
                disabled={pending}
                onApprove={(edge) => decide(edge, true)}
              />
            );
          })}
          {inspection?.candidates.length === 0 ? (
            <p className="plugin-manager-sheet-muted">
              No currently bound service-runtime candidates. Inspection does not install runtimes or
              approve missing bindings.
            </p>
          ) : null}
        </>
      )}
      {failure ? (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </Stack>
  );
}
