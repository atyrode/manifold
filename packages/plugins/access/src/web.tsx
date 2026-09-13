import "./styles.css";
import type { SectionProps } from "@manifold/plugin";
import { Chip, ControlIcon, Disclosure, KeyValueList, KeyValueRow, Stack } from "@manifold/ui";
import {
  CredentialsResponseSchema,
  InspectAgentRunResultSchema,
  formatManifoldUri,
  parseManifoldUri,
  RevokeResultSchema,
  type AgentRunInspection,
  type AgentRunTraceSummary,
  type InspectAgentRunRequest,
  type InspectAgentRunResult,
  type PrincipalCredentials,
} from "@manifold/protocol";
import { useCallback, useEffect, useId, useState, type ReactElement, type ReactNode } from "react";
import {
  ACCESS_INSPECT_AGENT_RUN_ACTION,
  ACCESS_LIST_CREDENTIALS_ACTION,
  ACCESS_REVOKE_ACTION,
} from "./index.ts";
import { partitionCredentials } from "./rows.ts";

/**
 * THE CREDENTIAL LIST (ADR 0019 §3) — "which browsers hold my key", made answerable and
 * actionable in the workspace.
 *
 * Before this section the data existed and nothing could reach it: `GET /api/introspect`
 * published principals to a root caller and nothing else did, so a human could not look and
 * neither could an agent. What is drawn here is `core.access.listCredentials`, narrowed by
 * the server to revocable identities and the viewer's authorized run chain, beside the
 * existing revoke door and the same headless inspection action used by agents.
 *
 * IT LIVES IN `core.access` BECAUSE THE CONCEPT DOES. Principals and the credentials they
 * hold are what this plugin mints and revokes; the fleet's half of the same question — which
 * machines are enrolled, and withdrawing one — is drawn by `core.machines` in its own
 * section. Two sections, two concepts, and no panel that knows about both (ADR 0019 §3:
 * "rendered by the plugin that owns each concept, not by a new god panel").
 *
 * NO POLL, and that is a decision rather than an omission. Nothing in the event vocabulary
 * announces a credential — a mint is not news, a revocation is a fence — so a cadence here
 * would be a timer with nothing to catch, paid for by every idle workspace (REGISTRY.md
 * §Budgets). The list is read once when the section mounts and re-read after a withdrawal,
 * which is the only moment this section can know the answer moved.
 */

/** 14px, the sidebar's row rhythm; the same size every other rail control is drawn at. */
const ROW_ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

/**
 * A credential's life in a human's words, and deliberately RELATIVE rather than a timestamp:
 * what an operator deciding whether to withdraw something needs is "this stops working in
 * three days", not an ISO string they have to subtract from today.
 */
function expiryLabel(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "no expiry";
  const days = Math.round((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "expires today";
  return days === 1 ? "expires tomorrow" : `expires in ${String(days)} days`;
}

/**
 * The one line under a principal's name: where it came from, when it arrived, and what it
 * holds right now. Joined with middots rather than stacked, because a sidebar row that grows
 * a paragraph stops being a row.
 */
function metaLine(row: PrincipalCredentials, now: number): string {
  const parts: string[] = [row.principal.kind];
  if (row.principal.origin !== undefined) parts.push(row.principal.origin);
  parts.push(`since ${new Date(row.createdAt).toLocaleDateString()}`);
  if (row.sessions.length === 0) parts.push("no live credential");
  else {
    const soonest = row.sessions.reduce<number | undefined>(
      (earliest, session) =>
        session.expiresAt === undefined
          ? earliest
          : Math.min(earliest ?? session.expiresAt, session.expiresAt),
      undefined,
    );
    const count = row.sessions.length;
    parts.push(count === 1 ? "1 session" : `${String(count)} sessions`);
    parts.push(expiryLabel(soonest, now));
  }
  return parts.join(" · ");
}

type InspectionRead =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "ready"; readonly result: InspectAgentRunResult };

/** One mounted snapshot, not a cache or a second history store. Callers key each request. */
function useInspection(host: SectionProps["host"], request: InspectAgentRunRequest): InspectionRead {
  const [read, setRead] = useState<InspectionRead>({ state: "loading" });
  const { runId, principalId, traceId, beforeTraceId, limit } = request;
  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const outcome = await host.client.action(ACCESS_INSPECT_AGENT_RUN_ACTION, {
          ...(runId === undefined ? { principalId } : { runId }),
          ...(traceId === undefined ? {} : { traceId }),
          ...(beforeTraceId === undefined ? {} : { beforeTraceId }),
          limit,
        });
        if (stale) return;
        if (!outcome.ok) {
          setRead({ state: "failed", message: outcome.denial.message });
          return;
        }
        const parsed = InspectAgentRunResultSchema.safeParse(outcome.result);
        setRead(
          parsed.success
            ? { state: "ready", result: parsed.data }
            : { state: "failed", message: "The run inspection could not be read." },
        );
      } catch {
        if (!stale) setRead({ state: "failed", message: "The run inspection could not be loaded." });
      }
    })();
    return () => {
      stale = true;
    };
  }, [host.client, runId, principalId, traceId, beforeTraceId, limit]);
  return read;
}

function inspectionTime(at: number | null): string {
  return at === null ? "Not recorded" : new Date(at).toLocaleString();
}

function InspectionFold({
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

function NativeReference({
  host,
  uri,
}: {
  readonly host: SectionProps["host"];
  readonly uri: string;
}): ReactElement {
  const ref = parseManifoldUri(uri);
  return ref === null || Object.values(ref).includes("[redacted]") ? (
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
  const read = useInspection(host, { runId, traceId, limit: 1 });
  if (read.state === "loading") return <p role="status">Loading trace {traceId}…</p>;
  if (read.state === "failed") return <p role="alert">{read.message}</p>;
  const result = read.result;
  if (result.availability === "origin_unavailable") {
    return <p>Origin unavailable. This identity has no retained run envelope.</p>;
  }
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
          : trace.targets.map((target) => <NativeReference key={target} host={host} uri={target} />)}
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
  readonly result: AgentRunInspection;
  readonly inspect: (request: InspectAgentRunRequest) => void;
  readonly olderPage: boolean;
}): ReactElement {
  const { run } = result;
  return (
    <Stack gap="0.5rem">
      <strong>{run.name} · {run.state}</strong>
      <p className="credential-inspection-note">
        Retained-only history · observed {inspectionTime(result.observedAt)}. Missing records are
        not proof that no activity occurred. Declarations are reported claims, not reasoning or
        authorization.
      </p>
      <KeyValueList>
        <KeyValueRow label="Run">{run.id}</KeyValueRow>
        <KeyValueRow label="Principal">{run.principalId}</KeyValueRow>
        <KeyValueRow label="Sponsor">{run.sponsorPrincipalId}</KeyValueRow>
        <KeyValueRow label="Purpose declaration">{run.purpose}</KeyValueRow>
        <KeyValueRow label="Task reference">{run.taskRef ?? "Not supplied"}</KeyValueRow>
        <KeyValueRow label="Scope">
          <NativeReference host={host} uri={run.target} /> · {run.reach}
        </KeyValueRow>
        <KeyValueRow label="Capabilities">{run.caps.join(", ")}</KeyValueRow>
        <KeyValueRow label="Authorization">{run.authorizationPath}</KeyValueRow>
        <KeyValueRow label="Created">{inspectionTime(run.createdAt)}</KeyValueRow>
        <KeyValueRow label="Expiry">{inspectionTime(run.expiresAt)}</KeyValueRow>
        <KeyValueRow label="Policy">
          {run.acknowledgedPolicyRevision === run.policyRevision ? "Acknowledged" : "Not acknowledged"}
          {" · "}{run.policyRevision}
          {run.acknowledgedPolicyRevision === null ? null : (
            <span className="credential-inspection-note">
              Acknowledged revision {run.acknowledgedPolicyRevision} ·{" "}
              {inspectionTime(run.policyAcknowledgedAt)}
            </span>
          )}
        </KeyValueRow>
        <KeyValueRow label="Cleanup">
          {run.cleanup.status === "failed" ? "cleanup_failed" : run.cleanup.status}
          {" · owner "}{run.cleanup.ownerPrincipalId}
          <span className="credential-inspection-note">
            {run.cleanup.revokedCredentials} credentials / {run.cleanup.revokedGrants} grants revoked
            {" · finished "}{inspectionTime(run.cleanup.finishedAt)}
          </span>
        </KeyValueRow>
      </KeyValueList>
      <InspectionFold title={`Run lineage · ${String(result.lineage.length)}`}>
        <p className="credential-inspection-note">
          Root {run.rootRunId} · parent {run.parentRunId ?? "none"} · depth {run.depth}/{run.maxDepth}
          {" · descendant limit "}{run.maxDescendants} · renewals {run.renewals}
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
              {credential.grant === null ? "Unavailable" : (
                <>
                  <NativeReference host={host} uri={credential.grant.node} />
                  {" · "}{credential.grant.effect} · {credential.grant.reach}
                  {" · "}{credential.grant.caps.join(", ")}
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
            <KeyValueRow label="First seen">{inspectionTime(connection.firstObservedAt)}</KeyValueRow>
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
          <TraceReference key={trace.traceId} host={host} runId={run.id} traceId={trace.traceId} summary={trace} />
        ))}
        {result.nextBeforeTraceId === null ? null : (
          <Chip className="credential-inspection-link" onClick={() => {
            if (result.nextBeforeTraceId !== null) {
              inspect({ runId: run.id, beforeTraceId: result.nextBeforeTraceId, limit: 50 });
            }
          }}>Older attempts</Chip>
        )}
        {olderPage ? (
          <Chip className="credential-inspection-link" onClick={() => inspect({ runId: run.id, limit: 50 })}>
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
                <NativeReference host={host} uri={formatManifoldUri({
                  kind: "job", jobId: job.jobId, machineId: job.machineId, operationId: job.operationId,
                })} /> · {job.state}
              </KeyValueRow>
              <KeyValueRow label="Operation">{job.pluginId} / {job.operationId}</KeyValueRow>
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
                  <NativeReference host={host} uri={formatManifoldUri({ kind: "terminal", terminalId: job.terminalId })} />
                </KeyValueRow>
              )}
            </KeyValueList>
            {job.origin === "retained" ? (
              <TraceReference host={host} runId={run.id} traceId={job.traceId} />
            ) : <p>Origin trace unavailable; ownership is not proof of completed cleanup.</p>}
          </Stack>
        ))}
      </InspectionFold>
      <InspectionFold title={`Terminals · ${String(result.terminals.length)}`}>
        {result.terminals.length === 0 ? <p>No retained terminals.</p> : null}
        {result.terminals.map((terminal) => (
          <Stack key={terminal.terminalId} className="credential-inspection-record" gap="0.25rem">
            <KeyValueList>
              <KeyValueRow label="Terminal">
                <NativeReference host={host} uri={formatManifoldUri({ kind: "terminal", terminalId: terminal.terminalId })} />
              </KeyValueRow>
              <KeyValueRow label="State">{terminal.state} · retained record</KeyValueRow>
              <KeyValueRow label="Machine">{terminal.machineId}</KeyValueRow>
              <KeyValueRow label="Container">
                <NativeReference host={host} uri={formatManifoldUri({ kind: "container", containerId: terminal.containerId })} />
              </KeyValueRow>
              <KeyValueRow label="Created">{inspectionTime(terminal.createdAt)}</KeyValueRow>
              <KeyValueRow label="Exit">{terminal.exitCode ?? "Not recorded"}</KeyValueRow>
            </KeyValueList>
            {terminal.traceId === null ? <p>Origin trace unavailable.</p> : (
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
  readonly request: InspectAgentRunRequest;
  readonly inspect: (request: InspectAgentRunRequest) => void;
}): ReactElement {
  const read = useInspection(host, request);
  if (read.state === "loading") return <p role="status">Loading agent run…</p>;
  if (read.state === "failed") return <p className="credential-failure" role="alert">{read.message}</p>;
  if (read.result.availability === "origin_unavailable") {
    return <p>Origin unavailable. This legacy agent identity has no retained run envelope.</p>;
  }
  return <RunSnapshot host={host} result={read.result} inspect={inspect} olderPage={request.beforeTraceId !== undefined} />;
}

function AgentRunInspector({
  host,
  principalId,
  id,
}: {
  readonly host: SectionProps["host"];
  readonly principalId: string;
  readonly id: string;
}): ReactElement {
  const [request, inspect] = useState<InspectAgentRunRequest>({ principalId, limit: 50 });
  return (
    <section id={id} className="credential-inspection" aria-label="Agent run inspection">
      <InspectionSnapshot key={JSON.stringify(request)} host={host} request={request} inspect={inspect} />
    </section>
  );
}

export function SessionsSection({ host }: SectionProps): ReactElement {
  const caps = host.client.selfCaps();
  const mayRevoke = caps.includes("*") || caps.includes("tokens:mint");
  const [rows, setRows] = useState<readonly PrincipalCredentials[] | null>(null);
  /**
   * When the list was READ, which is the instant every "expires in N days" label is
   * relative to. State written beside the rows it describes, never `Date.now()` in render:
   * the label describes the list as of its read, and a re-read refreshes both together.
   */
  const [readAt, setReadAt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Which row's withdrawal is ARMED. Revocation severs live sockets, so it is a two-press
   * act by construction: the first press says what will happen, the second does it. ONE slot
   * rather than a flag per row, because arming a second row must disarm the first.
   */
  const [armedId, setArmedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  /**
   * Whether the inactive fold is open. Collapsed on every mount, deliberately (#145): the
   * fold holds history, and a section that remembered it open would greet every boot with
   * the noise the fold exists to end.
   */
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [inspectedPrincipalId, setInspectedPrincipalId] = useState<string | null>(null);
  const inspectionId = useId();

  const read = useCallback(async (): Promise<void> => {
    const outcome = await host.client.action(ACCESS_LIST_CREDENTIALS_ACTION, {});
    if (!outcome.ok) {
      setFailure(outcome.denial.message);
      setRows([]);
      return;
    }
    const parsed = CredentialsResponseSchema.safeParse(outcome.result);
    if (!parsed.success) {
      setFailure("The credential list could not be read");
      setRows([]);
      return;
    }
    setFailure(null);
    setReadAt(Date.now());
    setRows(parsed.data.principals);
  }, [host.client]);

  /*
   * The boot read, in the shape the floor's own boot fetches wear (plugin-host.tsx): the
   * async work lives inside the effect and a stale flag swallows a resolution that lands
   * after unmount. `read` itself stays for the post-withdrawal refresh, an event path.
   */
  useEffect(() => {
    let stale = false;
    void (async (): Promise<void> => {
      if (stale) return;
      await read();
    })();
    return () => {
      stale = true;
    };
  }, [read]);

  /**
   * The door that already existed (`core.access.revoke`, `cleanup: true`), aimed by the list
   * that did not. It answers an exhaustive count — zero is a success, because a principal
   * whose credentials are already dead is exactly what a nervous administrator asks about
   * twice — so the result is parsed rather than trusted, and then the list is re-read: the
   * roster is server-owned, and this section must never paint a revocation it only hopes
   * happened.
   */
  const revoke = async (principalId: string): Promise<void> => {
    setPendingId(principalId);
    setFailure(null);
    try {
      const outcome = await host.client.action(ACCESS_REVOKE_ACTION, { principalId });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const record = RevokeResultSchema.safeParse(outcome.result);
      if (!record.success) {
        setFailure("The credentials were withdrawn, but the count could not be read");
        return;
      }
      await read();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not withdraw the credentials");
    } finally {
      setPendingId(null);
      setArmedId(null);
    }
  };

  const now = readAt;
  const live = rows?.reduce((total, row) => total + row.sessions.length, 0) ?? 0;
  const parts = partitionCredentials(rows ?? []);

  const renderRow = (row: PrincipalCredentials): ReactElement => {
    const self = row.principal.id === host.principal.id;
    const armed = armedId === row.principal.id;
    return (
      <div
        className={`credential-row${self ? " is-self" : ""}`}
        key={row.principal.id}
        data-principal={row.principal.id}
      >
        {/* THE COLOUR IS THE MARK. A principal is not an item, so there is no
            `ItemIcon` kind to ask for and borrowing one would tell a reader this row
            is a thing on a canvas. The pip is the presence colour the protocol
            assigns every identity — the same dot a cursor and an attendance row wear
            — so this list agrees with every other place the person appears. */}
        <span
          className="credential-pip"
          style={{ background: row.principal.color }}
          aria-hidden="true"
        />
        <span className="credential-name">
          {row.principal.kind === "agent" ? (
            <button
              className="credential-inspect"
              type="button"
              data-action={ACCESS_INSPECT_AGENT_RUN_ACTION}
              aria-label={`Inspect agent run for ${row.principal.name}`}
              aria-expanded={inspectedPrincipalId === row.principal.id}
              aria-controls={inspectedPrincipalId === row.principal.id ? inspectionId : undefined}
              onClick={() => setInspectedPrincipalId((current) => current === row.principal.id ? null : row.principal.id)}
            >
              <strong>{row.principal.name}</strong>
            </button>
          ) : <strong>{row.principal.name}</strong>}
          <span className="credential-meta">{metaLine(row, now)}</span>
        </span>
        {/* A row with nothing live has nothing to withdraw; the control is absent
            rather than disabled, because "press this to do nothing" is not an
            affordance. */}
        {mayRevoke && row.sessions.length > 0 ? (
          <button
            className="credential-revoke"
            type="button"
            data-action={ACCESS_REVOKE_ACTION}
            data-testid="credential-revoke"
            data-confirming={armed}
            aria-label={
              armed
                ? `Confirm withdrawing every credential of ${row.principal.name}`
                : `Withdraw every credential of ${row.principal.name}`
            }
            title={
              armed
                ? `Press again to withdraw ${String(row.sessions.length)} credential(s)${
                    self ? " — including this browser's" : ""
                  }`
                : `Withdraw every credential of ${row.principal.name}`
            }
            disabled={pendingId !== null}
            onBlur={() => {
              if (armed) setArmedId(null);
            }}
            onClick={() => {
              if (!armed) {
                setArmedId(row.principal.id);
                return;
              }
              void revoke(row.principal.id);
            }}
          >
            <ControlIcon kind="revoke" {...ROW_ICON} />
          </button>
        ) : null}
        {row.principal.kind === "agent" && inspectedPrincipalId === row.principal.id ? (
          <AgentRunInspector key={row.principal.id} host={host} principalId={row.principal.id} id={inspectionId} />
        ) : null}
      </div>
    );
  };

  return (
    <Stack className="sidebar-section-content" gap="0.35rem">
      <span className="sidebar-section-count">
        {live}/{rows?.length ?? 0} live
      </span>
      {failure === null ? null : <span className="credential-failure">{failure}</span>}
      <Stack gap="0.2rem" data-testid="credentials-rail">
        {rows === null ? (
          <span className="sidebar-section-empty">Loading credentials…</span>
        ) : rows.length === 0 ? (
          <span className="sidebar-section-empty">No credentials to show</span>
        ) : (
          <>
            {/* The living first and alone (#145): a row without a live credential is
                history, and on a workspace that has hosted gate runs, history outnumbers
                the living by an order of magnitude. */}
            {parts.live.length === 0 ? (
              <span className="sidebar-section-empty">No live credentials</span>
            ) : (
              parts.live.map(renderRow)
            )}
            {parts.inactive.length === 0 ? null : (
              <Disclosure
                className="credential-inactive"
                open={inactiveOpen}
                onOpenChange={setInactiveOpen}
                data-testid="credentials-inactive"
                header={
                  <span className="credential-inactive-header">
                    {parts.inactive.length === 1
                      ? "1 inactive identity"
                      : `${String(parts.inactive.length)} inactive identities`}
                  </span>
                }
              >
                <Stack gap="0.2rem">{parts.inactive.map(renderRow)}</Stack>
              </Disclosure>
            )}
          </>
        )}
      </Stack>
    </Stack>
  );
}
