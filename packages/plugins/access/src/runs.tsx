import type { SectionProps } from "@manifold/plugin";
import { Chip, Disclosure, KeyValueList, KeyValueRow, Stack } from "@manifold/ui";
import {
  InspectRunResultSchema,
  formatManifoldUri,
  parseManifoldUri,
  type InspectRunResult,
  type AgentRunTraceSummary,
  type InspectRunRequest,
} from "@manifold/protocol";
import { useState, type ReactElement, type ReactNode } from "react";
import { ACCESS_INSPECT_RUN_ACTION } from "./index.ts";
import { useAccessRead } from "./reads.ts";

export function inspectionTime(at: number | null): string {
  return at === null ? "Not recorded" : new Date(at).toLocaleString();
}

export function InspectionFold({
  title,
  children,
  initiallyOpen = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly initiallyOpen?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <Disclosure
      className="credential-inspection-fold"
      headerClassName="credential-inspection-heading"
      header={title}
      open={open}
      onOpenChange={setOpen}
    >
      <Stack gap="0.45rem">{children}</Stack>
    </Disclosure>
  );
}

export function NativeReference({
  host,
  uri,
}: {
  readonly host: SectionProps["host"];
  readonly uri: string;
}): ReactElement {
  const ref = parseManifoldUri(uri);
  const navigable =
    ref !== null &&
    (ref.kind === "container" ||
      ref.kind === "element" ||
      ref.kind === "tile" ||
      ref.kind === "terminal" ||
      ref.kind === "plugin" ||
      ref.kind === "agent" ||
      ref.kind === "run");
  return !navigable || ref === null || Object.values(ref).includes("[redacted]") ? (
    <span>{uri}</span>
  ) : (
    <Chip
      className="credential-inspection-link"
      aria-label={`Open ${uri}`}
      onClick={() => host.navigate(formatManifoldUri(ref))}
    >
      {uri}
    </Chip>
  );
}

function traceStatus(trace: AgentRunTraceSummary): string {
  if (trace.settlement === "pending_or_crashed") return "pending_or_crashed · outcome unknown";
  if (trace.outcome === null) return "Outcome unavailable";
  if (trace.outcome === "ok") return "Succeeded";
  if (trace.outcome === "failed") return "Failed";
  return `Refused · ${trace.outcome}`;
}

function ExactTrace({
  host,
  runId,
  traceId,
}: {
  readonly host: SectionProps["host"];
  readonly runId: string;
  readonly traceId: string;
}): ReactElement {
  const read = useAccessRead(host, ACCESS_INSPECT_RUN_ACTION, InspectRunResultSchema, {
    runId,
    traceId,
    limit: 1,
  });
  if (read.state === "loading") return <p role="status">Loading trace {traceId}…</p>;
  if (read.state === "failed") return <p role="alert">{read.message}</p>;
  const result = read.result;
  const trace = result.traces.find((entry) => entry.traceId === traceId);
  if (result.requestedTrace !== "available" || trace === undefined) {
    return <p>Trace {traceId} is unavailable in retained history. Its outcome is not known.</p>;
  }
  return (
    <KeyValueList>
      <KeyValueRow label="Attempt">{trace.action}</KeyValueRow>
      <KeyValueRow label="Outcome">{traceStatus(trace)}</KeyValueRow>
      <KeyValueRow label="At">{inspectionTime(trace.at)}</KeyValueRow>
      <KeyValueRow label="Actor">{trace.actor}</KeyValueRow>
      <KeyValueRow label="Authority">{trace.authority}</KeyValueRow>
      <KeyValueRow label="Origin">{trace.origin}</KeyValueRow>
      <KeyValueRow label="Connection">{trace.connectionId ?? "Not recorded"}</KeyValueRow>
      <KeyValueRow label="Agent declaration">
        {trace.agentDeclaration ?? "Not supplied"}
      </KeyValueRow>
      <KeyValueRow label="Targets">
        {trace.targets.length === 0
          ? "None recorded"
          : trace.targets.map((target) => (
              <NativeReference key={target} host={host} uri={target} />
            ))}
      </KeyValueRow>
    </KeyValueList>
  );
}

/** Native references stay on the same authorized, payload-free inspection door. */
function TraceReference({
  host,
  runId,
  traceId,
  summary,
}: {
  readonly host: SectionProps["host"];
  readonly runId: string;
  readonly traceId: string;
  readonly summary?: AgentRunTraceSummary;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      className="credential-inspection-trace"
      headerClassName="credential-inspection-heading"
      open={open}
      onOpenChange={setOpen}
      header={
        <span>
          <span className="credential-inspection-link">Trace {traceId}</span>
          {summary === undefined ? null : (
            <span className="credential-inspection-note">
              {summary.action} · {traceStatus(summary)}
            </span>
          )}
        </span>
      }
    >
      {open ? <ExactTrace host={host} runId={runId} traceId={traceId} /> : null}
    </Disclosure>
  );
}

function RunSnapshot({
  host,
  result,
  inspect,
  olderPage,
}: {
  readonly host: SectionProps["host"];
  readonly result: InspectRunResult;
  readonly inspect: (request: InspectRunRequest) => void;
  readonly olderPage: boolean;
}): ReactElement {
  const { run } = result;
  return (
    <Stack gap="0.5rem">
      <strong>
        {run.name} · {run.state}
      </strong>
      <p className="credential-inspection-note">
        Retained-only history · observed {inspectionTime(result.observedAt)}. Missing records are
        not proof that no activity occurred. Declarations are reported claims, not reasoning or
        authorization.
      </p>
      <KeyValueList>
        <KeyValueRow label="Run">{run.id}</KeyValueRow>
        <KeyValueRow label="Agent">
          <NativeReference
            host={host}
            uri={formatManifoldUri({ kind: "agent", agentId: run.agentId })}
          />
        </KeyValueRow>
        <KeyValueRow label="Activity">{run.activity}</KeyValueRow>
        <KeyValueRow label="Model">
          {run.model === undefined ? "Not reported" : `${run.model.provider} / ${run.model.model}`}
        </KeyValueRow>
        <KeyValueRow label="Harness session">
          {run.session === null ? "Not bound" : `${run.session.harness} · ${run.session.sessionId}`}
        </KeyValueRow>
        {run.session === null ? null : (
          <KeyValueRow label="Session machine">{run.session.machineId}</KeyValueRow>
        )}
        <KeyValueRow label="Principal">{run.principalId}</KeyValueRow>
        <KeyValueRow label="Sponsor">{run.sponsorPrincipalId}</KeyValueRow>
        <KeyValueRow label="Purpose declaration">{run.purpose}</KeyValueRow>
        {run.taskRef === undefined ? null : (
          <KeyValueRow label="Legacy external task">{run.taskRef}</KeyValueRow>
        )}
        <KeyValueRow label="Scope">
          <NativeReference host={host} uri={run.target} /> · {run.reach}
        </KeyValueRow>
        <KeyValueRow label="Capabilities">{run.caps.join(", ")}</KeyValueRow>
        <KeyValueRow label="Authorization">{run.authorizationPath}</KeyValueRow>
        <KeyValueRow label="Created">{inspectionTime(run.createdAt)}</KeyValueRow>
        <KeyValueRow label="Expiry">{inspectionTime(run.expiresAt)}</KeyValueRow>
        <KeyValueRow label="Policy">
          {run.acknowledgedPolicyRevision === run.policyRevision
            ? "Acknowledged"
            : "Not acknowledged"}
          {" · "}
          {run.policyRevision}
          {run.acknowledgedPolicyRevision === null ? null : (
            <span className="credential-inspection-note">
              Acknowledged revision {run.acknowledgedPolicyRevision} ·{" "}
              {inspectionTime(run.policyAcknowledgedAt)}
            </span>
          )}
        </KeyValueRow>
        <KeyValueRow label="Cleanup">
          {run.cleanup.status === "failed" ? "cleanup_failed" : run.cleanup.status}
          {" · owner "}
          {run.cleanup.ownerPrincipalId}
          <span className="credential-inspection-note">
            {run.cleanup.revokedCredentials} credentials / {run.cleanup.revokedGrants} grants
            revoked
            {" · finished "}
            {inspectionTime(run.cleanup.finishedAt)}
          </span>
        </KeyValueRow>
      </KeyValueList>
      <InspectionFold title={`Run lineage · ${String(result.lineage.length)}`}>
        <p className="credential-inspection-note">
          Root {run.rootRunId} · parent {run.parentRunId ?? "none"} · depth {run.depth}/
          {run.maxDepth}
          {" · descendant limit "}
          {run.maxDescendants} · renewals {run.renewals}
        </p>
        {result.lineageComplete ? null : <p>Lineage is incomplete or not fully authorized.</p>}
        {result.lineage.map((entry) => (
          <Chip
            key={entry.id}
            className="credential-inspection-link"
            aria-label={`Inspect run ${entry.name}`}
            aria-current={entry.id === run.id ? "true" : undefined}
            onClick={() => inspect({ runId: entry.id, limit: 50 })}
          >
            {entry.name} · {entry.state}
          </Chip>
        ))}
      </InspectionFold>
      <InspectionFold title={`Credentials · ${String(result.credentials.length)}`}>
        {result.credentials.length === 0 ? <p>No retained credentials.</p> : null}
        {result.credentials.map((credential, index) => (
          <KeyValueList key={index} className="credential-inspection-record">
            <KeyValueRow label="State">{credential.state}</KeyValueRow>
            <KeyValueRow label="Created">{inspectionTime(credential.createdAt)}</KeyValueRow>
            <KeyValueRow label="Expiry">
              {credential.expiresAt === null ? "No expiry" : inspectionTime(credential.expiresAt)}
            </KeyValueRow>
            <KeyValueRow label="Revoked">{inspectionTime(credential.revokedAt)}</KeyValueRow>
            <KeyValueRow label="Grant">
              {credential.grant === null ? (
                "Unavailable"
              ) : (
                <>
                  <NativeReference host={host} uri={credential.grant.node} />
                  {" · "}
                  {credential.grant.effect} · {credential.grant.reach}
                  {" · "}
                  {credential.grant.caps.join(", ")}
                </>
              )}
            </KeyValueRow>
          </KeyValueList>
        ))}
      </InspectionFold>
      <InspectionFold title={`Connections · ${String(result.connections.length)}`}>
        {result.connections.length === 0 ? <p>No retained or live connections.</p> : null}
        {result.connections.map((connection) => (
          <KeyValueList key={connection.connectionId} className="credential-inspection-record">
            <KeyValueRow label="Connection">{connection.connectionId}</KeyValueRow>
            <KeyValueRow label="State">
              {connection.state === "live" ? "Live" : "Closed or unavailable"}
            </KeyValueRow>
            <KeyValueRow label="First seen">
              {inspectionTime(connection.firstObservedAt)}
            </KeyValueRow>
            <KeyValueRow label="Last seen">{inspectionTime(connection.lastObservedAt)}</KeyValueRow>
          </KeyValueList>
        ))}
      </InspectionFold>
      <InspectionFold title={`Trace attempts · ${String(result.traces.length)}`} initiallyOpen>
        <p className="credential-inspection-note">
          Refusals are attempts too. pending_or_crashed means an unsettled attempt, not success.
        </p>
        {result.traces.length === 0 ? <p>No attempts in this retained page.</p> : null}
        {result.traces.map((trace) => (
          <TraceReference
            key={trace.traceId}
            host={host}
            runId={run.id}
            traceId={trace.traceId}
            summary={trace}
          />
        ))}
        {result.nextBeforeTraceId === null ? null : (
          <Chip
            className="credential-inspection-link"
            onClick={() => {
              if (result.nextBeforeTraceId !== null) {
                inspect({ runId: run.id, beforeTraceId: result.nextBeforeTraceId, limit: 50 });
              }
            }}
          >
            Older attempts
          </Chip>
        )}
        {olderPage ? (
          <Chip
            className="credential-inspection-link"
            onClick={() => inspect({ runId: run.id, limit: 50 })}
          >
            Latest retained attempts
          </Chip>
        ) : null}
      </InspectionFold>
      <InspectionFold title={`Jobs · ${String(result.jobs.length)}`}>
        {result.jobs.length === 0 ? <p>No retained jobs.</p> : null}
        {result.jobs.map((job) => (
          <Stack key={job.jobId} className="credential-inspection-record" gap="0.25rem">
            <KeyValueList>
              <KeyValueRow label="Job">
                {job.jobId} · {job.state}
              </KeyValueRow>
              <KeyValueRow label="Operation">
                {job.pluginId} / {job.operationId}
              </KeyValueRow>
              <KeyValueRow label="Machine">{job.machineId}</KeyValueRow>
              <KeyValueRow label="Installation revision">{job.installationRevision}</KeyValueRow>
              <KeyValueRow label="Artifact pin">{job.artifactSha256}</KeyValueRow>
              <KeyValueRow label="Origin">{job.origin}</KeyValueRow>
              <KeyValueRow label="Owner">{job.ownerState}</KeyValueRow>
              <KeyValueRow label="Parent job">{job.parentJobId ?? "None recorded"}</KeyValueRow>
              <KeyValueRow label="Created">{inspectionTime(job.createdAt)}</KeyValueRow>
              <KeyValueRow label="Started">{inspectionTime(job.startedAt)}</KeyValueRow>
              <KeyValueRow label="Finished">{inspectionTime(job.finishedAt)}</KeyValueRow>
              <KeyValueRow label="Exit">{job.exitCode ?? "Not recorded"}</KeyValueRow>
              {job.terminalId === null ? null : (
                <KeyValueRow label="Terminal">
                  <NativeReference
                    host={host}
                    uri={formatManifoldUri({ kind: "terminal", terminalId: job.terminalId })}
                  />
                </KeyValueRow>
              )}
            </KeyValueList>
            {job.origin === "retained" ? (
              <TraceReference host={host} runId={run.id} traceId={job.traceId} />
            ) : (
              <p>Origin trace unavailable; ownership is not proof of completed cleanup.</p>
            )}
          </Stack>
        ))}
      </InspectionFold>
      <InspectionFold title={`Terminals · ${String(result.terminals.length)}`}>
        {result.terminals.length === 0 ? <p>No retained terminals.</p> : null}
        {result.terminals.map((terminal) => (
          <Stack key={terminal.terminalId} className="credential-inspection-record" gap="0.25rem">
            <KeyValueList>
              <KeyValueRow label="Terminal">
                <NativeReference
                  host={host}
                  uri={formatManifoldUri({ kind: "terminal", terminalId: terminal.terminalId })}
                />
              </KeyValueRow>
              <KeyValueRow label="State">{terminal.state} · retained record</KeyValueRow>
              <KeyValueRow label="Machine">{terminal.machineId}</KeyValueRow>
              <KeyValueRow label="Container">
                <NativeReference
                  host={host}
                  uri={formatManifoldUri({ kind: "container", containerId: terminal.containerId })}
                />
              </KeyValueRow>
              <KeyValueRow label="Created">{inspectionTime(terminal.createdAt)}</KeyValueRow>
              <KeyValueRow label="Exit">{terminal.exitCode ?? "Not recorded"}</KeyValueRow>
            </KeyValueList>
            {terminal.traceId === null ? (
              <p>Origin trace unavailable.</p>
            ) : (
              <TraceReference host={host} runId={run.id} traceId={terminal.traceId} />
            )}
          </Stack>
        ))}
      </InspectionFold>
      {result.nativeTruncated ? <p>Native job or terminal history is truncated.</p> : null}
    </Stack>
  );
}

function InspectionSnapshot({
  host,
  request,
  inspect,
}: {
  readonly host: SectionProps["host"];
  readonly request: InspectRunRequest;
  readonly inspect: (request: InspectRunRequest) => void;
}): ReactElement {
  const read = useAccessRead(host, ACCESS_INSPECT_RUN_ACTION, InspectRunResultSchema, request);
  if (read.state === "loading") return <p role="status">Loading agent run…</p>;
  if (read.state === "failed")
    return (
      <p className="credential-failure" role="alert">
        {read.message}
      </p>
    );
  return (
    <RunSnapshot
      host={host}
      result={read.result}
      inspect={inspect}
      olderPage={request.beforeTraceId !== undefined}
    />
  );
}

export function RunInspector({
  host,
  runId,
}: SectionProps & { readonly runId: string }): ReactElement {
  const [request, inspect] = useState<InspectRunRequest>({ runId, limit: 50 });
  return (
    <section className="credential-inspection" aria-label="Run inspection">
      <InspectionSnapshot
        key={JSON.stringify(request)}
        host={host}
        request={request}
        inspect={inspect}
      />
    </section>
  );
}
