import type { SectionProps } from "@manifold/plugin";
import { FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import {
  canonicalJobJson,
  JobDeploymentDescriptionSchema,
  JobDeploymentListResultSchema,
  JobDeploymentRequestSchema,
  JobDeploymentReviewSchema,
  JobDeploymentSchema,
  type JobDeployment,
  type JobDeploymentDescription,
  type JobDeploymentRequest,
  type JobDeploymentReview,
  type JobDeploymentState,
  type MachineHalf,
  type MachineSummary,
} from "@manifold/protocol";
import { Cluster, Stack } from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";

type Host = SectionProps["host"];
type ReadResult<T> = { value: T; failure: null } | { value: null; failure: string };
const JOBS_TOPIC = { kind: "plugin", pluginId: "engine.jobs" } as const;
const STATE_LABELS = {
  pending: "Pending — awaiting preparation, not ready",
  installing: "Installing — awaiting native readiness",
  ready: "Prepared — installation acknowledged; reviewed consent current",
  needs_review: "Needs review — no automatic retry",
  refused: "Refused",
  cancelled: "Cancelled — unapplied preparation stopped",
  superseded: "Superseded — installation changed",
} satisfies Record<JobDeploymentState, string>;

async function request(host: Host, action: string, args: unknown): Promise<unknown> {
  const outcome = await host.client.action(action, args);
  if (!outcome.ok) throw new Error(outcome.denial.message);
  if (typeof outcome.result === "object" && outcome.result !== null && "refused" in outcome.result)
    throw new Error(
      typeof outcome.result.refused === "string" ? outcome.result.refused : "Request refused",
    );
  return outcome.result;
}

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Runtime preparation unavailable";
}

function ReviewedPreparation({ review }: { readonly review: JobDeploymentReview }): ReactElement {
  return (
    <Stack gap="0.65rem" className="plugin-manager-runtime-review">
      <p>
        {review.request.operationIds.length === 0
          ? "Installation approval only — no permission changes are requested. Existing consents are not revoked. No operation will run."
          : `Installation and consent for ${review.request.operationIds.join(", ")} only. No operation will run.`}
      </p>
      {review.targets.map((target) => {
        const artifact = target.platform ? review.machine.artifacts[target.platform] : undefined;
        return (
          <section
            key={target.machineId}
            className="plugin-manager-runtime-operation"
            data-machine={target.machineId}
            data-approvable={target.approvable}
          >
            <strong>{target.machineName || target.machineId}</strong>
            <p>
              {target.connected
                ? "Current owner proved and connected at review"
                : "Owner offline or unproved at review — installation is not acknowledged"}
              {" · "}
              {target.approvable ? "Eligible for this approval" : "Approval refused"}
            </p>
            {target.reason ? (
              <p className="plugin-manager-error" data-reason={target.reason}>
                {target.reason}
              </p>
            ) : null}
            {!target.connected && target.approvable ? (
              <p>
                Only these known pins may await owner reconnect. Changed authority, declaration,
                installation, consent or resource evidence requires a new review.
              </p>
            ) : null}
            <small>
              Platform:{" "}
              <code>{target.platform ?? "Unresolved — choose a platform and review again"}</code>
            </small>
            <strong>Exact requested permissions</strong>
            {target.consents.length === 0 ? (
              <p>No permission changes — installation approval only.</p>
            ) : (
              <ul aria-label={`Requested rights on ${target.machineName || target.machineId}`}>
                {target.consents.map((consent) => (
                  <li
                    key={`${consent.node}:${consent.cap}`}
                    data-node={consent.node}
                    data-cap={consent.cap}
                    data-approved={consent.approved}
                    data-revision={consent.revision ?? ""}
                    className={`plugin-manager-runtime-right${consent.cap === "network:host" || consent.cap === "locations:write" || consent.cap === "locations:create" ? " is-high-risk" : ""}`}
                  >
                    <div>
                      <strong>
                        {consent.cap === "network:host"
                          ? "HIGH RISK — host network, including reachable local services"
                          : consent.cap === "locations:write"
                            ? "Writable location — may modify existing data"
                            : consent.cap === "locations:create"
                              ? "Create access — may create location contents"
                              : consent.cap}
                      </strong>
                      <code>{consent.cap}</code>
                      <small>{consent.node}</small>
                      <small>
                        {consent.approved
                          ? "Consent enabled at review"
                          : "Consent not enabled at review — approval requested"}
                        {" · "}consent revision: <code>{consent.revision ?? "none"}</code>
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {review.request.operationIds.length > 0 &&
            !target.consents.some((consent) => consent.cap === "network:host") ? (
              <p>No host-network permission requested by the selected operations.</p>
            ) : null}
            <details className="plugin-manager-runtime-evidence">
              <summary>Inspect installation revisions, hashes and resource bindings</summary>
              <div className="plugin-manager-runtime-identity">
                <small>
                  Machine: <code>{target.machineId}</code>
                </small>
                <small>
                  Artifact SHA-256: <code>{target.artifactSha256 ?? "Unknown"}</code>
                </small>
                {artifact ? (
                  <>
                    <small>
                      Entry SHA-256: <code>{artifact.entrySha256}</code>
                    </small>
                    <small>
                      Format: {artifact.format} · entry: {artifact.entry.join("/")}
                    </small>
                  </>
                ) : null}
                <small>
                  Current installation revision:{" "}
                  <code>{target.expectedInstallationRevision ?? "Not installed"}</code>
                </small>
                <small>
                  Proposed installation revision:{" "}
                  <code>{target.installationRevision ?? "Unavailable"}</code>
                </small>
                <strong>Reviewed native resource pins</strong>
                {target.resources.length === 0 ? (
                  <p>No resource pins in this review.</p>
                ) : (
                  <ul aria-label={`Resource pins on ${target.machineName || target.machineId}`}>
                    {target.resources.map((resource) => (
                      <li
                        key={`${resource.group}:${resource.name}`}
                        className="plugin-manager-runtime-identity"
                      >
                        <small>
                          {resource.group}: {resource.name}
                        </small>
                        <code>
                          {resource.sha256 ?? "Unknown — cannot approve a future binding"}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
                <pre>{JSON.stringify(target.resourceBindings, null, 2)}</pre>
              </div>
            </details>
          </section>
        );
      })}
      <details className="plugin-manager-runtime-evidence">
        <summary>Inspect review identity and exact machine declaration</summary>
        <div className="plugin-manager-runtime-identity">
          <small>
            Plugin: <code>{review.request.pluginId}</code>
          </small>
          <small>
            Deployment: <code>{review.request.deploymentId}</code>
          </small>
          <small>
            Declaration SHA-256: <code>{review.declarationSha256}</code>
          </small>
          <small>
            Review digest: <code>{review.reviewDigest}</code>
          </small>
          <pre>{JSON.stringify(review.machine, null, 2)}</pre>
        </div>
      </details>
      <p>
        Approval is bound to this actor and credential, exact destinations and current server
        evidence. Plugin enablement permits preparation; it is not installation, owner
        acknowledgement or consent. Sending a command is not an acknowledgement, and no approval
        starts a job.
      </p>
    </Stack>
  );
}

/** The bounded progress door is readable without exposing root administration or its review. */
export function useDestinationPreparation(host: Host, machineId: string, pluginId: string) {
  return usePolledResource<ReadResult<JobDeploymentDescription> | null>(
    async () => {
      try {
        const value = JobDeploymentDescriptionSchema.parse(
          await request(host, "engine.jobs.describeDeployment", { machineId, pluginId }),
        );
        if (
          value.deployment &&
          (value.deployment.machineId !== machineId || value.deployment.pluginId !== pluginId)
        )
          throw new Error("Preparation response does not match this destination");
        return { value, failure: null };
      } catch (reason) {
        return { value: null, failure: failureMessage(reason) };
      }
    },
    FALLBACK_POLL_MS,
    {
      key: `engine.jobs.describeDeployment:${machineId}:${pluginId}`,
      initial: null,
      topics: [...host.topics.machines, JOBS_TOPIC],
      events: host.client,
    },
  );
}

export function DestinationPreparation({
  observation,
  onRefresh,
}: {
  readonly observation: ReadResult<JobDeploymentDescription> | null;
  readonly onRefresh: () => void;
}): ReactElement {
  const deployment = observation?.value?.deployment;
  return (
    <Stack
      gap="0.35rem"
      className="plugin-manager-runtime-operation"
      data-action="engine.jobs.describeDeployment"
    >
      <h5>Destination preparation</h5>
      {observation?.failure ? (
        <p className="plugin-manager-error" role="alert">
          {observation.failure}
        </p>
      ) : (
        <p role="status" data-state={deployment?.state}>
          {observation === null
            ? "Reading saved preparation…"
            : deployment
              ? STATE_LABELS[deployment.state]
              : "No saved preparation reported. Inspect installation and consent below."}
        </p>
      )}
      {deployment ? (
        <>
          <details className="plugin-manager-runtime-evidence">
            <summary>Inspect deployment identity</summary>
            <small>
              Deployment: <code>{deployment.deploymentId}</code> · revision {deployment.revision}
            </small>
          </details>
          {deployment.reason ? <p>{deployment.reason}</p> : null}
        </>
      ) : null}
      <p>
        Preparation status does not start a job. Each run still needs current scoped authority and
        admission.
      </p>
      <button type="button" className="plugin-manager-filter" onClick={onRefresh}>
        Refresh destination preparation
      </button>
    </Stack>
  );
}

function SavedPreparation({
  host,
  pluginId,
  deploymentId,
  onChanged,
  disabled,
  onPendingChange,
  onUseSelection,
}: {
  readonly host: Host;
  readonly pluginId: string;
  readonly deploymentId: string;
  readonly onChanged: () => void;
  readonly disabled: boolean;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onUseSelection: (request: JobDeploymentRequest) => void;
}): ReactElement {
  const canApprove = host.client.selfCaps().includes("*");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null);
  const confirmFocus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmRevision !== null) confirmFocus.current?.focus();
  }, [confirmRevision]);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { value: observation, refresh } = usePolledResource<ReadResult<JobDeployment> | null>(
    async () => {
      try {
        const value = JobDeploymentSchema.parse(
          await request(host, "engine.jobs.readDeployment", { deploymentId }),
        );
        if (value.deploymentId !== deploymentId || value.pluginId !== pluginId)
          throw new Error("Saved preparation does not match this deployment and plugin");
        return { value, failure: null };
      } catch (reason) {
        return { value: null, failure: failureMessage(reason) };
      }
    },
    FALLBACK_POLL_MS,
    {
      key: `engine.jobs.readDeployment:${deploymentId}`,
      initial: null,
      enabled: canApprove,
      topics: [...host.topics.machines, JOBS_TOPIC],
      events: host.client,
    },
  );
  const deployment = canApprove ? observation?.value : null;
  const cancellable =
    deployment &&
    !deployment.cancelled &&
    deployment.targets.some(
      (target) =>
        target.state === "pending" ||
        target.state === "installing" ||
        target.state === "needs_review" ||
        target.state === "refused",
    );
  const cancel = async (): Promise<void> => {
    if (
      busy.current ||
      disabled ||
      !canApprove ||
      !cancellable ||
      !deployment ||
      confirmRevision !== deployment.revision
    )
      return;
    busy.current = true;
    setPending(true);
    onPendingChange(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = JobDeploymentSchema.parse(
        await request(host, "engine.jobs.cancelDeployment", {
          deploymentId,
          expectedRevision: deployment.revision,
        }),
      );
      if (result.deploymentId !== deploymentId || result.pluginId !== pluginId || !result.cancelled)
        throw new Error("Cancellation response does not match this deployment");
      setNotice(
        "Cancellation recorded. Only unapplied preparation stops; completed installations and rights remain. Reading current progress…",
      );
    } catch (reason) {
      setFailure(
        `${failureMessage(reason)}. Read current progress before deciding whether to cancel again.`,
      );
    } finally {
      busy.current = false;
      setPending(false);
      onPendingChange(false);
      setConfirmRevision(null);
      refresh();
      onChanged();
    }
  };
  return (
    <div
      className="plugin-manager-runtime-saved"
      data-deployment={deploymentId}
      aria-busy={pending}
    >
      <div className="plugin-manager-runtime-review-heading">
        <h5>Saved deployment progress</h5>
        {deployment ? (
          <p role="status">
            {deployment.targets.length === 1
              ? STATE_LABELS[deployment.targets[0]!.state]
              : `${deployment.targets.length} destinations — inspect individual progress below`}
          </p>
        ) : null}
        <button
          type="button"
          className="plugin-manager-filter"
          data-action="engine.jobs.readDeployment"
          disabled={pending || disabled || !canApprove}
          onClick={refresh}
        >
          Refresh saved progress
        </button>
      </div>
      <Stack
        gap="0.65rem"
        className="plugin-manager-runtime-saved-body"
        tabIndex={0}
        role="region"
        aria-label="Saved deployment evidence and controls"
      >
        {observation === null ? <p role="status">Reading saved preparation…</p> : null}
        {observation?.failure ? (
          <p className="plugin-manager-error" role="alert">
            {observation.failure}. No current progress is verified.
          </p>
        ) : null}
        {deployment ? (
          <>
            <p>
              Historical approval saved {new Date(deployment.approvedAt).toLocaleString()} ·
              progress revision {deployment.revision}
            </p>
            {deployment.cancelled ? (
              <p>Cancelled. Completed work is not uninstalled or revoked.</p>
            ) : null}
            <ul aria-label="Current destination progress">
              {deployment.targets.map((target) => (
                <li
                  key={target.machineId}
                  className="plugin-manager-runtime-operation"
                  data-machine={target.machineId}
                  data-state={target.state}
                  data-reason={target.reason ?? ""}
                >
                  <strong>
                    {deployment.review.targets.find((row) => row.machineId === target.machineId)
                      ?.machineName || target.machineId}
                  </strong>
                  <details className="plugin-manager-runtime-evidence">
                    <summary>Inspect destination identity</summary>
                    <small>
                      Machine: <code>{target.machineId}</code>
                    </small>
                  </details>
                  <p role="status">{STATE_LABELS[target.state]}</p>
                  <small>
                    {target.connected
                      ? "Current owner proved and connected — connection alone is not installation acknowledgement"
                      : "Owner offline or unproved — installation is not currently acknowledged"}
                  </small>
                  {target.reason ? <p>{target.reason}</p> : null}
                </li>
              ))}
            </ul>
            <p>
              Prepared means the current owner acknowledged the installation and the reviewed
              consent is current. Install-only approval grants no permission to run. Every run still
              requires current scoped authority and admission; revoked consent is never repaired
              automatically.
            </p>
            <details>
              <summary>Original approved review — historical evidence, not current consent</summary>
              <div className="plugin-manager-runtime-identity">
                <small>
                  Deployment: <code>{deploymentId}</code>
                </small>
                <small>
                  Historical approving actor: <code>{deployment.approvedBy}</code>
                </small>
              </div>
              <ReviewedPreparation review={deployment.review} />
            </details>
            <button
              type="button"
              className="plugin-manager-filter"
              disabled={pending || disabled || !canApprove}
              onClick={() => onUseSelection(deployment.review.request)}
            >
              Use these destinations and operations in a new draft
            </button>
            <p>
              Reusing the selection does not reuse approval. Review current evidence again before
              making any change.
            </p>
            <p>
              Cancellation stops only unapplied preparation. It does not uninstall, purge or revoke
              completed work; use the existing per-machine consent controls to revoke rights.
            </p>
            {confirmRevision === deployment.revision && cancellable ? (
              <Cluster gap="0.4rem">
                <button
                  ref={confirmFocus}
                  type="button"
                  className="plugin-manager-purge is-confirming"
                  data-action="engine.jobs.cancelDeployment"
                  disabled={pending || disabled || !canApprove}
                  onClick={() => void cancel()}
                >
                  {pending ? "Cancelling…" : "Confirm: stop unapplied preparation"}
                </button>
                <button
                  type="button"
                  className="plugin-manager-filter"
                  disabled={pending || disabled}
                  onClick={() => setConfirmRevision(null)}
                >
                  Keep pending preparation
                </button>
              </Cluster>
            ) : (
              <button
                type="button"
                className="plugin-manager-purge"
                disabled={pending || disabled || !canApprove || !cancellable}
                onClick={() => {
                  setConfirmRevision(deployment.revision);
                  setNotice(null);
                }}
              >
                Cancel unapplied preparation…
              </button>
            )}
          </>
        ) : null}
        {failure ? (
          <p className="plugin-manager-error" role="alert">
            {failure}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </Stack>
    </div>
  );
}

/** Draft selection is local; every pin, consent projection and approval comes from native doors. */
export function RuntimePreparation({
  host,
  pluginId,
  declaration,
  enabled,
  machines,
}: {
  readonly host: Host;
  readonly pluginId: string;
  readonly declaration: MachineHalf;
  readonly enabled: boolean;
  readonly machines: readonly MachineSummary[] | null;
}): ReactElement {
  const canApprove = host.client.selfCaps().includes("*");
  const [targets, setTargets] = useState<JobDeploymentRequest["targets"]>([]);
  const [operationIds, setOperationIds] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState<{
    review: JobDeploymentReview;
    declaration: string;
  } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<"review" | "apply" | "cancel" | null>(null);
  const busy = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reviewFocus = useRef<HTMLDivElement>(null);
  const draftFocus = useRef<HTMLHeadingElement>(null);
  const declarationKey = canonicalJobJson(declaration);
  const review = reviewed?.review ?? null;
  const reviewCurrent = reviewed?.declaration === declarationKey;
  const { value: saved, refresh } = usePolledResource<ReadResult<JobDeployment[]> | null>(
    async () => {
      try {
        const result = JobDeploymentListResultSchema.parse(
          await request(host, "engine.jobs.listDeployments", { pluginId, limit: 100 }),
        );
        if (result.deployments.some((deployment) => deployment.pluginId !== pluginId))
          throw new Error("Saved preparation list does not match this plugin");
        return { value: result.deployments, failure: null };
      } catch (reason) {
        return { value: null, failure: failureMessage(reason) };
      }
    },
    FALLBACK_POLL_MS,
    {
      key: `engine.jobs.listDeployments:${pluginId}:100`,
      initial: null,
      enabled: canApprove,
      topics: [...host.topics.machines, JOBS_TOPIC],
      events: host.client,
    },
  );
  const activeId = selectedId ?? saved?.value?.[0]?.deploymentId ?? null;
  useEffect(() => {
    if (review) reviewFocus.current?.focus();
  }, [review]);
  const invalidate = (): void => {
    setReviewed(null);
    setAttempted(false);
    setFailure(null);
    setNotice("Selection changed. Review again before approving; no rights were granted.");
  };
  const reviewDraft = async (): Promise<void> => {
    if (busy.current || !canApprove || !enabled) return;
    const parsed = JobDeploymentRequestSchema.safeParse({
      deploymentId: crypto.randomUUID(),
      pluginId,
      targets,
      operationIds,
    });
    if (!parsed.success) {
      setFailure(
        "Select 1–64 distinct machine destinations and at most 128 declared operations. Choose a declared platform or let the server resolve it.",
      );
      return;
    }
    busy.current = true;
    setPending("review");
    setReviewed(null);
    setAttempted(false);
    setFailure(null);
    setNotice(null);
    try {
      const value = JobDeploymentReviewSchema.parse(
        await request(host, "engine.jobs.reviewDeployment", parsed.data),
      );
      if (canonicalJobJson(value.request) !== canonicalJobJson(parsed.data))
        throw new Error(
          "Review response does not match the exact requested destinations and operations",
        );
      setReviewed({ review: value, declaration: declarationKey });
    } catch (reason) {
      setFailure(`${failureMessage(reason)}. Your target and operation draft is retained.`);
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  const apply = async (): Promise<void> => {
    if (
      busy.current ||
      !canApprove ||
      !enabled ||
      !review ||
      !reviewCurrent ||
      !review.approvable ||
      attempted
    )
      return;
    busy.current = true;
    setPending("apply");
    setAttempted(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = JobDeploymentSchema.parse(
        await request(host, "engine.jobs.applyDeployment", {
          request: review.request,
          reviewDigest: review.reviewDigest,
        }),
      );
      if (
        result.deploymentId !== review.request.deploymentId ||
        result.pluginId !== pluginId ||
        result.review.reviewDigest !== review.reviewDigest
      )
        throw new Error("Approval response does not match the reviewed deployment");
      setNotice(
        "Installation approval saved. Preparation may now install and apply only the reviewed consent; it never executes an operation. Inspect current owner acknowledgement and progress below.",
      );
    } catch (reason) {
      setFailure(
        `${failureMessage(reason)}. Do not assume nothing applied. Check saved progress below; your draft is retained. Changed or refused evidence requires a fresh review, never an automatic retry.`,
      );
    } finally {
      setSelectedId(review.request.deploymentId);
      refresh();
      busy.current = false;
      setPending(null);
    }
  };
  return (
    <Stack
      gap="0.75rem"
      className="plugin-manager-runtime-preparation"
      aria-busy={pending !== null}
    >
      <h5 ref={draftFocus} tabIndex={-1}>
        Prepare runtime destinations
      </h5>
      <p>
        Choose exact machines, then review the server's pinned installation and optional consent
        before applying. Plugin enablement is separate from installation and permissions. New
        machines never join this selection automatically; no operation is selected by default.
      </p>
      {!canApprove ? (
        <p>
          Review, approval and saved approval administration require root authority. Destination
          progress and existing scoped inspection remain available below.
        </p>
      ) : null}
      {!enabled ? (
        <p>
          Plugin disabled — new preparation is unavailable. Saved unapplied preparation can still be
          cancelled.
        </p>
      ) : null}
      <fieldset disabled={pending !== null || !canApprove}>
        <legend>1. Explicit destinations · {targets.length}/64 selected</legend>
        {machines === null ? (
          <p>Machine inventory unavailable or loading. No destinations have been inferred.</p>
        ) : machines.length === 0 ? (
          <p>No enrolled machines available.</p>
        ) : null}
        <div className="plugin-manager-runtime-destinations">
          {machines?.map((machine) => {
            const selected = targets.find((target) => target.machineId === machine.id);
            return (
              <div key={machine.id} className="plugin-manager-runtime-destination">
                <label className="plugin-manager-runtime-choice">
                  <input
                    type="checkbox"
                    checked={selected !== undefined}
                    disabled={!selected && targets.length >= 64}
                    data-machine={machine.id}
                    onChange={(event) => {
                      if (busy.current) return;
                      setTargets(
                        event.target.checked
                          ? [...targets, { machineId: machine.id }]
                          : targets.filter((target) => target.machineId !== machine.id),
                      );
                      invalidate();
                    }}
                  />
                  <span>
                    <strong>{machine.name || machine.id}</strong>
                    <small>
                      {machine.id} ·{" "}
                      {machine.revoked
                        ? "credential revoked"
                        : machine.online
                          ? "transport online; runtime evidence checked at review"
                          : "offline; known evidence required"}
                    </small>
                  </span>
                </label>
                {selected ? (
                  <label className="plugin-manager-install-field">
                    <span>Platform for {machine.name || machine.id}</span>
                    <select
                      value={selected.platform ?? ""}
                      data-machine={machine.id}
                      onChange={(event) => {
                        if (busy.current) return;
                        const platform = event.target.value as
                          NonNullable<JobDeploymentRequest["targets"][number]["platform"]> | "";
                        setTargets(
                          targets.map((target) =>
                            target.machineId === machine.id
                              ? { machineId: machine.id, ...(platform ? { platform } : {}) }
                              : target,
                          ),
                        );
                        invalidate();
                      }}
                    >
                      <option value="">Resolve from server evidence</option>
                      {Object.keys(declaration.artifacts).map((platform) => (
                        <option key={platform} value={platform}>
                          {platform}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            );
          })}
          {targets
            .filter((target) => !machines?.some((machine) => machine.id === target.machineId))
            .map((target) => (
              <label key={target.machineId} className="plugin-manager-runtime-choice">
                <input
                  type="checkbox"
                  checked
                  onChange={() => {
                    if (busy.current) return;
                    setTargets(targets.filter((row) => row.machineId !== target.machineId));
                    invalidate();
                  }}
                />
                <span>
                  {target.machineId}
                  <small>
                    Selected destination absent from the current roster. Server review must resolve
                    or refuse it.
                  </small>
                </span>
              </label>
            ))}
        </div>
        <p>
          An ambiguous platform needs an explicit choice and another review. Offline or unknown
          evidence is not proof of availability.
        </p>
      </fieldset>
      <fieldset disabled={pending !== null || !canApprove}>
        <legend>2. Optional operation consent · {operationIds.length} selected</legend>
        <p>
          {operationIds.length === 0
            ? "Installation approval only — no permission changes requested."
            : "Only the selected operations request permissions. Review shows the exact location, operation and network capabilities per machine."}
        </p>
        {Object.entries(declaration.operations).map(([operationId, operation]) => (
          <label key={operationId} className="plugin-manager-runtime-choice">
            <input
              type="checkbox"
              checked={operationIds.includes(operationId)}
              disabled={!operationIds.includes(operationId) && operationIds.length >= 128}
              data-operation={operationId}
              onChange={(event) => {
                if (busy.current) return;
                setOperationIds(
                  event.target.checked
                    ? [...operationIds, operationId]
                    : operationIds.filter((id) => id !== operationId),
                );
                invalidate();
              }}
            />
            <span>
              <strong>{operationId}</strong>
              <small className={operation.network === "host" ? "plugin-manager-runtime-risk" : ""}>
                {operation.network === "host"
                  ? "HIGH RISK — host networking"
                  : "No networking declared"}
              </small>
              {operation.locations.map((location) => (
                <small
                  key={`${location.locationId}:${location.access}`}
                  className={
                    location.access === "write" || location.access === "create"
                      ? "plugin-manager-runtime-risk"
                      : ""
                  }
                >
                  {location.access} · {location.locationId}
                </small>
              ))}
            </span>
          </label>
        ))}
        {operationIds
          .filter((id) => !declaration.operations[id])
          .map((id) => (
            <label key={id} className="plugin-manager-runtime-choice">
              <input
                type="checkbox"
                checked
                onChange={() => {
                  if (busy.current) return;
                  setOperationIds(operationIds.filter((operationId) => operationId !== id));
                  invalidate();
                }}
              />
              <span>{id} · no longer declared; remove or server review will refuse</span>
            </label>
          ))}
      </fieldset>
      <button
        type="button"
        className="plugin-manager-filter plugin-manager-runtime-primary"
        data-action="engine.jobs.reviewDeployment"
        disabled={pending !== null || !canApprove || !enabled || targets.length === 0}
        onClick={() => void reviewDraft()}
      >
        {pending === "review"
          ? "Reviewing current evidence…"
          : review
            ? "Review again with current evidence"
            : "3. Review exact preparation"}
      </button>
      {review ? (
        <div
          ref={reviewFocus}
          tabIndex={-1}
          role="region"
          className="plugin-manager-runtime-review-focus"
          aria-label="Server-reviewed preparation"
          data-review-digest={review.reviewDigest}
        >
          <div className="plugin-manager-runtime-review-heading">
            <h5>
              Review installation
              {review.request.operationIds.length > 0 ? " and permissions" : " only"}
            </h5>
            <p role="status">
              {!reviewCurrent
                ? "Declaration changed — review again."
                : !review.approvable
                  ? "Approval refused — inspect destination evidence."
                  : attempted
                    ? "Apply attempted — inspect saved progress before reviewing again."
                    : `${review.targets.length} exact destination${review.targets.length === 1 ? "" : "s"} · ${review.request.operationIds.length === 0 ? "no permission changes" : `${review.request.operationIds.length} selected operation${review.request.operationIds.length === 1 ? "" : "s"}`}`}
            </p>
            <button
              type="button"
              className="plugin-manager-filter plugin-manager-runtime-primary"
              data-action="engine.jobs.applyDeployment"
              disabled={
                pending !== null ||
                !canApprove ||
                !enabled ||
                !reviewCurrent ||
                !review.approvable ||
                attempted
              }
              onClick={() => void apply()}
            >
              {pending === "apply"
                ? "Saving and applying reviewed preparation…"
                : attempted
                  ? "Apply attempted — inspect saved progress"
                  : review.request.operationIds.length === 0
                    ? "4. Approve and prepare installation only"
                    : "4. Approve and prepare installation with exact permissions"}
            </button>
            <small>
              No operation will run. Installation and current owner acknowledgement are tracked
              separately below.
            </small>
          </div>
          <div
            className="plugin-manager-runtime-review-body"
            tabIndex={0}
            role="region"
            aria-label="Exact reviewed installation and permission evidence"
          >
            <ReviewedPreparation review={review} />
          </div>
        </div>
      ) : null}
      {failure ? (
        <p className="plugin-manager-error" role="alert">
          {failure}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {canApprove ? (
        <Stack gap="0.65rem" className="plugin-manager-runtime-history">
          <Cluster gap="0.4rem">
            <h5>Saved preparations</h5>
            <button
              type="button"
              className="plugin-manager-filter"
              data-action="engine.jobs.listDeployments"
              onClick={refresh}
            >
              Refresh saved list
            </button>
          </Cluster>
          <p>
            Latest 100 saved approvals for this plugin, including other operators. Progress is
            re-read on native jobs and machine events and reconnect, not reconstructed from this
            draft.
          </p>
          {saved === null ? <p role="status">Reading saved approvals…</p> : null}
          {saved?.failure ? (
            <p className="plugin-manager-error" role="alert">
              {saved.failure}
            </p>
          ) : null}
          {saved?.value?.length === 0 ? <p>No saved preparations reported.</p> : null}
          {saved?.value && saved.value.length > 0 ? (
            <label className="plugin-manager-install-field">
              <span>Saved deployment to inspect</span>
              <select
                value={activeId ?? ""}
                disabled={pending !== null}
                onChange={(event) => {
                  if (!busy.current) setSelectedId(event.target.value);
                }}
              >
                {activeId &&
                !saved.value.some((deployment) => deployment.deploymentId === activeId) ? (
                  <option value={activeId}>{activeId} · reading requested deployment</option>
                ) : null}
                {saved.value.map((deployment) => (
                  <option key={deployment.deploymentId} value={deployment.deploymentId}>
                    {new Date(deployment.approvedAt).toLocaleString()} · {deployment.targets.length}{" "}
                    destinations · {deployment.deploymentId}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {activeId ? (
            <SavedPreparation
              key={activeId}
              host={host}
              pluginId={pluginId}
              deploymentId={activeId}
              onChanged={refresh}
              disabled={pending !== null}
              onPendingChange={(active) => {
                busy.current = active;
                if (active) setSelectedId(activeId);
                setPending(active ? "cancel" : null);
              }}
              onUseSelection={(savedRequest) => {
                if (busy.current) return;
                setTargets(savedRequest.targets);
                setOperationIds(savedRequest.operationIds);
                invalidate();
                draftFocus.current?.focus();
              }}
            />
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
