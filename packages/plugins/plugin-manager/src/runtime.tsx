import type { SectionProps } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import {
  canonicalJobJson,
  formatManifoldUri,
  JobDescriptionSchema,
  JobRequestSchema,
  PublicJobSchema,
  type Cap,
  type JobDescription,
  type MachineHalf,
  type MachineOperation,
  type MachineSummary,
  type PluginRosterEntry,
  type JobRequest,
  type PublicJob,
} from "@manifold/protocol";
import { Cluster, Stack } from "@manifold/ui";
import { useEffect, useState, type ReactElement } from "react";

type Host = SectionProps["host"];
type ReadResult<T> = { value: T; failure: null } | { value: null; failure: string };
type Input = Record<string, string | number | boolean>;
type ConsentRight = { node: string; cap: Cap; label: string };
type JobIdentity = Readonly<Pick<PublicJob, "jobId" | "machineId" | "pluginId" | "operationId">>;

/** Only the public action outcome is interpreted here; no input or output bytes are echoed. */
async function request(host: Host, action: string, args: unknown): Promise<unknown> {
  const outcome = await host.client.action(action, args);
  if (!outcome.ok) throw new Error(outcome.denial.message);
  if (
    typeof outcome.result === "object" &&
    outcome.result !== null &&
    "refused" in outcome.result
  ) {
    throw new Error(
      typeof outcome.result.refused === "string" ? outcome.result.refused : "Request refused",
    );
  }
  return outcome.result;
}

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Machine request unavailable";
}

function operationRights(
  machineId: string,
  operationId: string,
  operation: MachineOperation,
): ConsentRight[] {
  const node = formatManifoldUri({ kind: "operation", machineId, operationId });
  return [
    { node, cap: "machines:run", label: "Run this operation" },
    { node, cap: "jobs:read", label: "Read its job status" },
    { node, cap: "jobs:cancel", label: "Cancel its jobs" },
    { node, cap: "operations:invoke", label: "Allow governed operation invocation" },
    ...(operation.network === "host"
      ? [{ node, cap: "network:host" as const, label: "HIGH RISK — host networking" }]
      : []),
  ];
}

function ConsentRow({
  right,
  description,
  pending,
  canApprove,
  onConsent,
}: {
  readonly right: ConsentRight;
  readonly description: JobDescription | null;
  readonly pending: boolean;
  readonly canApprove: boolean;
  readonly onConsent: (right: ConsentRight, enabled: boolean) => void;
}): ReactElement {
  const consent = description?.consents.find(
    (row) => row.node === right.node && row.cap === right.cap,
  );
  const approved = consent?.enabled === true;
  return (
    <li
      className={`plugin-manager-runtime-right${right.cap === "network:host" ? " is-high-risk" : ""}`}
    >
      <div>
        <strong>{right.label}</strong>
        <code>{right.cap}</code>
        <small>{right.node}</small>
        <small>
          {description === null
            ? "Consent not verified"
            : approved
              ? "Explicitly approved"
              : "Not approved"}
          {consent ? ` · decision revision ${consent.revision}` : ""}
        </small>
      </div>
      <button
        type="button"
        className="plugin-manager-filter"
        data-action="engine.jobs.consent"
        data-node={right.node}
        data-cap={right.cap}
        aria-label={`${approved ? "Revoke" : "Approve"} ${right.cap} on ${right.node}`}
        disabled={pending || !canApprove}
        onClick={() => onConsent(right, !approved)}
      >
        {approved ? "Revoke" : "Approve"}
      </button>
    </li>
  );
}

/** One scalar control per declared field, never an executable, environment or cwd editor. */
function OperationForm({
  operationId,
  operation,
  declaration,
  disabled,
  onRun,
}: {
  readonly operationId: string;
  readonly operation: MachineOperation;
  readonly declaration: MachineHalf;
  readonly disabled: boolean;
  readonly onRun: (input: Input, outputs: JobRequest["outputs"]) => Promise<void>;
}): ReactElement {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [bindings, setBindings] = useState<Record<string, { locationId: string; path: string }>>(
    {},
  );
  const writableLocations = Object.keys(declaration.locations).filter(
    (locationId) =>
      declaration.locations[locationId]?.kind !== "file" &&
      operation.locations.some(
        (location) => location.locationId === locationId && location.access !== "read",
      ),
  );
  const submit = async (): Promise<void> => {
    const input: Input = {};
    for (const [name, field] of Object.entries(operation.input)) {
      const text = draft[name] ?? "";
      if (text === "" && (field.type !== "string" || field.enum !== undefined || !field.required)) {
        if (field.required) {
          setFailure(`${name} is required`);
          return;
        }
        continue;
      }
      const value =
        field.enum !== undefined
          ? field.enum[Number(text)]
          : field.type === "number"
            ? Number(text)
            : field.type === "boolean"
              ? text === "true"
              : text;
      if (
        value === undefined ||
        typeof value !== field.type ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (typeof value === "string" && value.length > (field.maxLength ?? 4096)) ||
        (field.format === "revisioned-id" &&
          (typeof value !== "string" ||
            !/^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._-]{1,128}$/.test(value)))
      ) {
        setFailure(`${name} does not match its declared ${field.format ?? field.type} bounds`);
        return;
      }
      input[name] = value;
    }
    if (JSON.stringify(input).length > 65536) {
      setFailure("Combined inputs exceed 65536 characters");
      return;
    }
    const outputs = JobRequestSchema.shape.outputs.safeParse(
      operation.outputs.flatMap((name) => {
        const binding = bindings[name];
        return binding?.locationId
          ? [{ name, locationId: binding.locationId, components: binding.path.split("/") }]
          : [];
      }),
    );
    if (!outputs.success) {
      setFailure(
        "Output paths must contain 1–16 named components, without traversal, and at most 30 bindings",
      );
      return;
    }
    setFailure(null);
    await onRun(input, outputs.data);
  };
  return (
    <form
      className="plugin-manager-runtime-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void submit();
      }}
    >
      {Object.entries(operation.input).map(([name, field]) => (
        <label key={name} className="plugin-manager-install-field">
          <span>
            {name} · {field.format ?? field.type}
            {field.required ? " · required" : " · optional"}
          </span>
          {field.enum !== undefined || field.type === "boolean" ? (
            <select
              aria-label={`${operationId} ${name}`}
              value={draft[name] ?? ""}
              required={field.required}
              disabled={disabled}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [name]: event.target.value }))
              }
            >
              <option value="">{field.required ? "Choose a value" : "Not supplied"}</option>
              {field.enum !== undefined ? (
                field.enum.map((value, index) => (
                  <option key={index} value={String(index)}>
                    {String(value)}
                  </option>
                ))
              ) : (
                <>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </>
              )}
            </select>
          ) : (
            <input
              className="plugin-manager-search"
              aria-label={`${operationId} ${name}`}
              type={field.type === "number" ? "number" : "text"}
              step={field.type === "number" ? "any" : undefined}
              maxLength={field.maxLength ?? 4096}
              required={field.required && field.type !== "string"}
              pattern={
                field.format === "revisioned-id"
                  ? "[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._-]{1,128}"
                  : undefined
              }
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={draft[name] ?? ""}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [name]: event.target.value }))
              }
            />
          )}
        </label>
      ))}
      {Object.keys(operation.input).length === 0 ? (
        <p className="plugin-manager-sheet-muted">No declared inputs.</p>
      ) : null}
      {operation.outputs.map((name) => (
        <div key={name} className="plugin-manager-install-field">
          <label>
            <span>Output {name} — optional named-location binding</span>
            <select
              aria-label={`${operationId} output ${name} location`}
              disabled={disabled}
              value={bindings[name]?.locationId ?? ""}
              onChange={(event) =>
                setBindings((current) => ({
                  ...current,
                  [name]: { locationId: event.target.value, path: current[name]?.path ?? "" },
                }))
              }
            >
              <option value="">No persistent binding</option>
              {writableLocations.map((locationId) => (
                <option key={locationId} value={locationId}>
                  {locationId}
                </option>
              ))}
            </select>
          </label>
          {bindings[name]?.locationId ? (
            <label>
              <span>Relative output name inside the approved location</span>
              <input
                className="plugin-manager-search"
                aria-label={`${operationId} output ${name} path`}
                disabled={disabled}
                required
                maxLength={2063}
                autoComplete="off"
                spellCheck={false}
                value={bindings[name]?.path ?? ""}
                onChange={(event) =>
                  setBindings((current) => ({
                    ...current,
                    [name]: {
                      locationId: current[name]?.locationId ?? "",
                      path: event.target.value,
                    },
                  }))
                }
              />
            </label>
          ) : null}
        </div>
      ))}
      <button
        type="submit"
        className="plugin-manager-filter"
        data-action="engine.jobs.execute"
        data-operation={operationId}
        disabled={disabled}
      >
        Run {operationId}
      </button>
      {failure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      )}
    </form>
  );
}

function JobStatus({
  host,
  jobId,
  machineId,
  pluginId,
  operationId,
}: {
  readonly host: Host;
  readonly jobId: string;
  readonly machineId: string;
  readonly pluginId: string;
  readonly operationId: string;
}): ReactElement {
  const node = { kind: "job" as const, machineId, operationId, jobId };
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { value: observation, refresh } = usePolledResource<ReadResult<PublicJob> | null>(
    async () => {
      try {
        const value = PublicJobSchema.parse(await request(host, "engine.jobs.status", { node }));
        if (
          value.jobId !== jobId ||
          value.machineId !== machineId ||
          value.pluginId !== pluginId ||
          value.operationId !== operationId
        )
          throw new Error("Job response does not match this request");
        return { value, failure: null };
      } catch (reason) {
        return { value: null, failure: failureMessage(reason) };
      }
    },
    FALLBACK_POLL_MS,
    {
      key: `engine.jobs.status:${formatManifoldUri(node)}`,
      initial: null,
      topics: [node],
      events: host.client,
    },
  );
  const job = observation?.value;
  const terminal =
    job !== null &&
    job !== undefined &&
    ["exited", "interrupted", "cancelled", "refused"].includes(job.state);
  const cancel = async (): Promise<void> => {
    setPending(true);
    setNotice(null);
    try {
      const result = await request(host, "engine.jobs.cancel", { node });
      if (
        typeof result !== "object" ||
        result === null ||
        !("accepted" in result) ||
        result.accepted !== true
      )
        throw new Error("Cancellation acknowledgement could not be read");
      setNotice("Cancellation requested — refresh to observe the machine's final state.");
      refresh();
    } catch (reason) {
      setNotice(failureMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      className="plugin-manager-runtime-job"
      aria-label="Job status"
      data-testid="plugin-manager-job-status"
    >
      <strong>Job {jobId}</strong>
      <small>
        Machine {machineId} · operation {operationId}
      </small>
      <p role="status">
        {observation === null
          ? "Reading job status…"
          : observation.failure !== null
            ? observation.failure
            : `Last observed state: ${observation.value.state}`}
      </p>
      {job?.result ? (
        <>
          <p>
            Exit code: {job.result.exitCode ?? "none"} · reason: {job.result.reason ?? "none"}
          </p>
          <small>
            Owner {job.result.ownerId} · generation {job.result.ownerGeneration}
          </small>
          <small>Request digest {job.result.requestDigest}</small>
          {job.result.usage ? (
            <small>
              Elapsed {job.result.usage.elapsedMs} ms · memory {job.result.usage.memoryBytes} bytes
              · output {job.result.usage.outputBytes} bytes
            </small>
          ) : null}
          {job.result.outputs.map((output) => (
            <small key={output.outputId}>
              Output {output.name}: {output.bytes} bytes · SHA-256 {output.sha256}
            </small>
          ))}
        </>
      ) : null}
      {job ? (
        <details>
          <summary>Authority and attribution</summary>
          <div className="plugin-manager-runtime-identity">
            <small>Requester {job.authority.requester}</small>
            <small>
              Origin {job.authority.origin.kind} · trace {job.authority.origin.traceId}
            </small>
            {job.authority.origin.kind === "schedule" ? (
              <small>
                Schedule {job.authority.origin.scheduleId} · revision{" "}
                {job.authority.origin.revision} · nominal time {job.authority.origin.nominalAt}
              </small>
            ) : null}
            {job.authority.origin.kind === "invocation" ? (
              <small>
                Parent job {job.authority.origin.parentJobId} · invocation{" "}
                {job.authority.origin.invocationId}
              </small>
            ) : null}
            <small>
              {job.authority.executor
                ? `Executor ${job.authority.executor.machineId} · owner ${job.authority.executor.ownerId} · generation ${job.authority.executor.ownerGeneration}`
                : "No executor recorded"}
            </small>
            {job.authority.decision ? (
              <>
                <small>
                  Decision {job.authority.decision.decisionId} · policy revision{" "}
                  {job.authority.decision.policyRevision}
                </small>
                {job.authority.decision.grants.map((grant, index) => (
                  <small key={index}>
                    {grant.node} · {grant.cap} · {grant.allowed ? "allowed" : "denied"} · grant{" "}
                    {grant.grantId ?? "none"} · authorizer{" "}
                    {grant.authorizer ?? "not attributed to a grant"} · revision {grant.revision}
                  </small>
                ))}
                {job.authority.decision.consents.map((consent, index) => (
                  <small key={index}>
                    Consent {consent.node} · revision {consent.revision} · artifact{" "}
                    {consent.artifactSha256}
                  </small>
                ))}
              </>
            ) : (
              <small>No admission decision recorded</small>
            )}
          </div>
        </details>
      ) : null}
      <p className="plugin-manager-sheet-muted">
        Metadata only. Output bytes and input values are not displayed. Status and cancellation
        remain subject to your current authority and explicit consent.
      </p>
      <Cluster gap="0.4rem">
        <button
          type="button"
          className="plugin-manager-filter"
          data-action="engine.jobs.status"
          onClick={refresh}
        >
          Refresh job status
        </button>
        <button
          type="button"
          className="plugin-manager-filter"
          data-action="engine.jobs.cancel"
          disabled={pending || terminal}
          onClick={() => void cancel()}
        >
          Cancel job
        </button>
      </Cluster>
      {notice === null ? null : <p role="status">{notice}</p>}
    </section>
  );
}

function MachineSetup({
  host,
  entry,
  machine,
  declaration,
  onJobRequested,
}: {
  readonly host: Host;
  readonly entry: PluginRosterEntry;
  readonly machine: MachineSummary;
  readonly declaration: MachineHalf;
  readonly onJobRequested: (job: JobIdentity) => void;
}): ReactElement {
  const artifacts = Object.entries(declaration.artifacts);
  const [target, setTarget] = useState(artifacts.length === 1 ? artifacts[0]![0] : "");
  const artifact = artifacts.find(([name]) => name === target)?.[1];
  const manifestJson = canonicalJobJson(declaration);
  const [computedRevision, setComputedRevision] = useState<{
    manifestJson: string;
    result: ReadResult<string>;
  } | null>(null);
  const revisionResult =
    computedRevision?.manifestJson === manifestJson ? computedRevision.result : null;
  const revision = revisionResult?.value ?? null;
  const revisionFailure = revisionResult?.failure ?? null;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pluginId = entry.manifest.id;
  const canApprove = host.client.selfCaps().includes("*");
  const { value: observation, refresh } = usePolledResource<ReadResult<JobDescription> | null>(
    async () => {
      try {
        const value = JobDescriptionSchema.parse(
          await request(host, "engine.jobs.describe", { machineId: machine.id, pluginId }),
        );
        if (value.machineId !== machine.id || value.pluginId !== pluginId)
          throw new Error("Installation response does not match this machine and plugin");
        return { value, failure: null };
      } catch (reason) {
        return { value: null, failure: failureMessage(reason) };
      }
    },
    FALLBACK_POLL_MS,
    {
      key: `engine.jobs.describe:${machine.id}:${pluginId}`,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
    },
  );
  const description = observation?.value ?? null;
  const supportedTargets = artifacts.filter(([name]) => description?.platforms.includes(name));
  const supported = description?.platforms.includes(target) === true;
  const installation = description?.installation;
  const matches =
    revision !== null &&
    installation !== undefined &&
    installation !== null &&
    artifact !== undefined &&
    installation.revision === revision &&
    installation.artifactSha256 === artifact.sha256;
  const consentDescription = matches ? description : null;
  const connected = machine.online && machine.revoked !== true && description?.connected === true;
  const ready =
    connected &&
    supported &&
    matches &&
    installation?.enabled === true &&
    installation.ready &&
    !installation.purgeRequested &&
    entry.enabled;
  useEffect(() => {
    let active = true;
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(manifestJson))
      .then((bytes) => {
        if (active)
          setComputedRevision({
            manifestJson,
            result: {
              value: Array.from(new Uint8Array(bytes), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
              failure: null,
            },
          });
      })
      .catch(() => {
        if (active)
          setComputedRevision({
            manifestJson,
            result: {
              value: null,
              failure: "Cannot bind the manifest revision: SHA-256 is unavailable",
            },
          });
      });
    return () => {
      active = false;
    };
  }, [manifestJson]);
  const perform = async (run: () => Promise<void>): Promise<void> => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      await run();
      refresh();
    } catch (reason) {
      setFailure(failureMessage(reason));
      refresh();
    } finally {
      setPending(false);
    }
  };
  const consent = (right: ConsentRight, enabled: boolean): void => {
    if (!matches || !installation) return;
    void perform(async () => {
      const result = await request(host, "engine.jobs.consent", {
        machineId: machine.id,
        pluginId,
        installationRevision: installation.revision,
        artifactSha256: installation.artifactSha256,
        node: right.node,
        cap: right.cap,
        enabled,
      });
      if (typeof result !== "object" || result === null || Object.keys(result).length !== 0)
        throw new Error("Consent acknowledgement could not be read");
      setNotice(
        "Consent decision submitted. The rows reflect the next authoritative read, not this click.",
      );
    });
  };
  const locationRights: ConsentRight[] = [];
  for (const operation of Object.values(declaration.operations))
    for (const location of operation.locations) {
      const node = formatManifoldUri({
        kind: "location",
        machineId: machine.id,
        locationId: location.locationId,
      });
      const cap = `locations:${location.access}` as const;
      if (!locationRights.some((right) => right.node === node && right.cap === cap))
        locationRights.push({ node, cap, label: `${location.access} ${location.locationId}` });
    }
  const rightApproved = (right: ConsentRight): boolean =>
    consentDescription?.consents.some(
      (row) => row.node === right.node && row.cap === right.cap && row.enabled,
    ) === true;
  const state =
    machine.revoked === true
      ? "Machine credential revoked"
      : !machine.online
        ? "Machine offline"
        : observation === null
          ? "Reading readiness…"
          : observation.failure !== null
            ? "Readiness unavailable"
            : !description?.connected
              ? "Runtime unavailable — no proved job-owner connection"
              : supportedTargets.length === 0
                ? "Unsupported — no declared artifact matches the proved runtime platforms"
                : !entry.enabled
                  ? "Plugin disabled — execution unavailable"
                  : !artifact || !supported
                    ? "Choose a supported declared artifact target"
                    : revision === null
                      ? revisionFailure === null
                        ? "Computing declaration revision…"
                        : "Declaration revision unavailable"
                      : !installation
                        ? "Not installed on this machine"
                        : !matches
                          ? "Different artifact or declaration revision installed — install the reviewed declaration"
                          : installation.purgeRequested
                            ? "Purge pending"
                            : !installation.enabled
                              ? "Installation disabled"
                              : !installation.ready
                                ? "Installation pending — native acknowledgement not received"
                                : "Installed — native acknowledgement received";
  return (
    <Stack gap="0.65rem" className="plugin-manager-runtime-machine">
      <label className="plugin-manager-install-field">
        <span>Declared artifact target</span>
        <select
          aria-label="Declared artifact target"
          value={target}
          disabled={pending}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">Choose target</option>
          {artifacts.map(([name]) => (
            <option
              key={name}
              value={name}
              disabled={description?.connected === true && !description.platforms.includes(name)}
            >
              {name}
              {description?.connected === true && !description.platforms.includes(name)
                ? " · unsupported"
                : ""}
            </option>
          ))}
        </select>
      </label>
      {artifacts.length === 0 ? (
        <p className="plugin-manager-error">
          Unsupported: this manifest declares no machine artifacts.
        </p>
      ) : null}
      <p className="plugin-manager-sheet-muted">
        Proved runtime platforms:{" "}
        {description?.connected ? description.platforms.join(", ") || "none" : "unavailable"}.
        Platform compatibility does not promise sandbox readiness: the native runtime must
        acknowledge installation and admit each operation.
      </p>
      {artifact ? (
        <div className="plugin-manager-runtime-identity">
          <small>
            Artifact SHA-256 <code>{artifact.sha256}</code>
          </small>
          <small>
            Entry SHA-256 <code>{artifact.entrySha256}</code>
          </small>
          <small>
            Format {artifact.format} · entry {artifact.entry.join("/")}
          </small>
        </div>
      ) : null}
      <div className="plugin-manager-runtime-identity">
        <small>
          Reviewed declaration revision{" "}
          <code>{revision ?? (revisionFailure === null ? "Computing…" : "Unavailable")}</code>
        </small>
        <small>
          The revision hashes this exact machine declaration; the artifact hash pins downloaded
          bytes. A change needs a fresh installation and explicit consent.
        </small>
        {installation ? (
          <>
            <small>
              Installed revision <code>{installation.revision}</code>
            </small>
            <small>
              Installed artifact <code>{installation.artifactSha256}</code>
            </small>
          </>
        ) : null}
      </div>
      <p role="status" data-testid="plugin-manager-runtime-readiness">
        {state}
      </p>
      <Cluster gap="0.4rem">
        <button
          type="button"
          className="plugin-manager-filter"
          data-action="engine.jobs.describe"
          onClick={refresh}
        >
          Refresh readiness and consent
        </button>
        <button
          type="button"
          className="plugin-manager-filter"
          data-action="engine.jobs.install"
          disabled={
            pending ||
            !canApprove ||
            !entry.enabled ||
            !connected ||
            !supported ||
            !artifact ||
            !revision
          }
          onClick={() => {
            if (!artifact || !revision) return;
            void perform(async () => {
              const result = await request(host, "engine.jobs.install", {
                machineId: machine.id,
                pluginId,
                installationRevision: revision,
                artifactSha256: artifact.sha256,
                machine: declaration,
              });
              if (
                typeof result !== "object" ||
                result === null ||
                !("accepted" in result) ||
                result.accepted !== true
              )
                throw new Error("Installation acknowledgement could not be read");
              setNotice(
                "Installation requested, not yet ready. Refresh readiness for the native acknowledgement.",
              );
            });
          }}
        >
          Install exact manifest artifact
        </button>
      </Cluster>
      {!canApprove ? (
        <p className="plugin-manager-sheet-muted">
          Installation and consent changes require an administrator. Your existing scoped execution
          authority is checked separately.
        </p>
      ) : null}
      <p className="plugin-manager-sheet-muted">
        Enabling a plugin or holding root authority never approves these rows. Each approval is
        bound to this machine, installation revision, artifact hash, exact node and capability.
        Credentials are not granted or exposed here.
      </p>
      {observation?.failure ? (
        <p className="plugin-manager-error" role="alert">
          {observation.failure}
        </p>
      ) : null}
      {failure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      )}
      {revisionFailure === null ? null : (
        <p className="plugin-manager-error" role="alert">
          {revisionFailure}
        </p>
      )}
      {notice === null ? null : <p role="status">{notice}</p>}
      <h5>Named-location rights</h5>
      {Object.entries(declaration.locations).map(([id, location]) => (
        <div className="plugin-manager-runtime-location" key={id}>
          <strong>{id}</strong>
          <small>
            {location.anchor}/{location.components.join("/")} · revision {location.revision} ·{" "}
            {location.kind ?? "directory"}
          </small>
          {location.guestPath ? <small>Guest mount {location.guestPath}</small> : null}
        </div>
      ))}
      {locationRights.length === 0 ? (
        <p className="plugin-manager-sheet-muted">No named-location access requested.</p>
      ) : (
        <ul>
          {locationRights.map((right) => (
            <ConsentRow
              key={`${right.node}:${right.cap}`}
              right={right}
              description={consentDescription}
              pending={pending}
              canApprove={canApprove && matches}
              onConsent={consent}
            />
          ))}
        </ul>
      )}
      <h5>Declared operations</h5>
      {Object.entries(declaration.operations).map(([operationId, operation]) => {
        const rights = operationRights(machine.id, operationId, operation);
        const required = rights.filter(
          (right) => right.cap === "machines:run" || right.cap === "network:host",
        );
        const resources = operation.locations.map((location) => ({
          node: formatManifoldUri({
            kind: "location",
            machineId: machine.id,
            locationId: location.locationId,
          }),
          cap: `locations:${location.access}` as const,
          label: location.locationId,
        }));
        const approved = [...required, ...resources].every(rightApproved);
        return (
          <section
            key={operationId}
            className="plugin-manager-runtime-operation"
            data-operation={operationId}
          >
            <h5>{operationId}</h5>
            <p
              className={
                operation.network === "host"
                  ? "plugin-manager-runtime-risk"
                  : "plugin-manager-sheet-muted"
              }
            >
              {operation.network === "host"
                ? "HIGH RISK: uses the machine's host network, including reachable local services. No network isolation is promised."
                : "Declares no networking — native admission must enforce network isolation."}
            </p>
            <small>
              Declared arguments:{" "}
              {operation.argv
                .map((slot) =>
                  "literal" in slot ? JSON.stringify(slot.literal) : `<${slot.input}>`,
                )
                .join(" ") || "none"}
            </small>
            <small>Runtime tools: {operation.runtimeTools.join(", ") || "none"}</small>
            <small>
              Location effects:{" "}
              {operation.locations
                .map((location) => `${location.access} ${location.locationId}`)
                .join(", ") || "none"}
            </small>
            <small>
              Limits: {operation.limits.timeoutMs} ms · {operation.limits.memoryBytes} memory bytes
              · {operation.limits.processes} processes · {operation.limits.outputBytes} output bytes
            </small>
            <small>
              Named outputs: {operation.outputs.join(", ") || "none"}. Optional bindings stay inside
              declared writable locations; raw output is never displayed.
            </small>
            {operation.stdin ? (
              <small>
                Declares stdin. This form supplies schema inputs only; it does not open an
                interactive byte channel.
              </small>
            ) : null}
            <ul>
              {rights.map((right) => (
                <ConsentRow
                  key={right.cap}
                  right={right}
                  description={consentDescription}
                  pending={pending}
                  canApprove={canApprove && matches}
                  onConsent={consent}
                />
              ))}
            </ul>
            {!approved ? (
              <p className="plugin-manager-sheet-muted">
                Run requires explicit operation and requested location/network approvals. Status and
                cancellation have separate rights.
              </p>
            ) : null}
            <OperationForm
              key={`${operationId}:${revision}`}
              operationId={operationId}
              operation={operation}
              declaration={declaration}
              disabled={pending || !ready || !approved}
              onRun={(input, outputs) =>
                perform(async () => {
                  const jobId = crypto.randomUUID();
                  const result = PublicJobSchema.parse(
                    await request(host, "engine.jobs.execute", {
                      jobId,
                      machineId: machine.id,
                      pluginId,
                      operationId,
                      input,
                      outputs,
                    }),
                  );
                  if (
                    result.jobId !== jobId ||
                    result.machineId !== machine.id ||
                    result.pluginId !== pluginId ||
                    result.operationId !== operationId
                  )
                    throw new Error("Execution response does not match this request");
                  onJobRequested({ jobId, machineId: machine.id, pluginId, operationId });
                  setNotice(
                    `Job ${jobId}: ${result.state}. Admission is not successful completion.`,
                  );
                })
              }
            />
          </section>
        );
      })}
    </Stack>
  );
}

/** Existing plugin detail seat, using only roster declarations and public machine/job doors. */
export function MachineRuntime({
  host,
  entry,
}: {
  readonly host: Host;
  readonly entry: PluginRosterEntry;
}): ReactElement {
  const [machineId, setMachineId] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [jobs, setJobs] = useState<readonly JobIdentity[]>([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const selectedJob = jobs.find((job) => job.jobId === selectedJobId);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(),
    FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      enabled: entry.manifest.machine !== undefined,
      topics: host.topics.machines,
      events: host.client,
      onError: (reason) => setFailure(failureMessage(reason)),
    },
  );
  const declaration = entry.manifest.machine;
  const machine = machines?.find((row) => row.id === machineId);
  return (
    <section
      className="plugin-manager-sheet-card plugin-manager-runtime"
      data-testid="plugin-manager-machine-runtime"
    >
      <h4>Machine operations</h4>
      {declaration === undefined ? (
        <p className="plugin-manager-sheet-muted">
          No machine operations declared. This plugin has no machine artifact to install or approve.
        </p>
      ) : (
        <>
          <label className="plugin-manager-install-field">
            <span>Machine</span>
            <select
              aria-label="Machine for plugin operations"
              value={machineId}
              onChange={(event) => setMachineId(event.target.value)}
            >
              <option value="">Choose a machine</option>
              {machines?.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {row.revoked ? "revoked" : row.online ? "online" : "offline"}
                </option>
              ))}
            </select>
          </label>
          {machine === undefined ? (
            <ul aria-label="Declared machine effects">
              {Object.entries(declaration.operations).map(([id, operation]) => (
                <li className="plugin-manager-runtime-operation" key={id}>
                  <strong>{id}</strong>
                  <small>
                    Requests machines:run. Location effects:{" "}
                    {operation.locations
                      .map((location) => `${location.access} ${location.locationId}`)
                      .join(", ") || "none"}
                    .
                  </small>
                  <p
                    className={
                      operation.network === "host"
                        ? "plugin-manager-runtime-risk"
                        : "plugin-manager-sheet-muted"
                    }
                  >
                    {operation.network === "host"
                      ? "HIGH RISK: requests host networking, including reachable local services."
                      : "Declares no networking."}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {machines === null ? (
            <p className="plugin-manager-sheet-muted">Loading machines…</p>
          ) : machines.length === 0 ? (
            <p className="plugin-manager-sheet-muted">
              No enrolled machines. Enroll a machine before installing a machine artifact.
            </p>
          ) : null}
          {failure === null ? null : (
            <p className="plugin-manager-error" role="alert">
              {failure}
              <button
                type="button"
                className="plugin-manager-filter"
                onClick={() => {
                  setFailure(null);
                  refresh();
                }}
              >
                Refresh machines
              </button>
            </p>
          )}
          {machine ? (
            <MachineSetup
              key={`${entry.manifest.id}:${machine.id}`}
              host={host}
              entry={entry}
              machine={machine}
              declaration={declaration}
              onJobRequested={(job) => {
                setJobs((current) => [...current, job]);
                setSelectedJobId(job.jobId);
              }}
            />
          ) : (
            <p className="plugin-manager-sheet-muted">
              Choose a machine to inspect exact installation and consent. No rights are granted by
              selecting it.
            </p>
          )}
        </>
      )}
      {jobs.length > 0 ? (
        <label className="plugin-manager-install-field">
          <span>Jobs requested from this detail view</span>
          <select
            aria-label="Requested job"
            value={selectedJobId}
            onChange={(event) => setSelectedJobId(event.target.value)}
          >
            {jobs.map((job) => (
              <option key={job.jobId} value={job.jobId}>
                {job.machineId} · {job.operationId} · {job.jobId}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selectedJob ? (
        <JobStatus
          key={selectedJob.jobId}
          host={host}
          jobId={selectedJob.jobId}
          operationId={selectedJob.operationId}
          machineId={selectedJob.machineId}
          pluginId={selectedJob.pluginId}
        />
      ) : null}
    </section>
  );
}
