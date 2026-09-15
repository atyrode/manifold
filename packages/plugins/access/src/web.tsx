import "./styles.css";
import type { SectionProps } from "@manifold/plugin";
import { Chip, ControlIcon, Disclosure, Stack } from "@manifold/ui";
import {
  ListRunsResultSchema,
  CredentialsResponseSchema,
  InstanceServiceDescriptionSchema,
  ListAgentsResultSchema,
  PrincipalAccessPauseResultSchema,
  RevokeResultSchema,
  formatManifoldUri,
  type PrincipalCredentials,
} from "@manifold/protocol";
import { useState, type ReactElement } from "react";
import {
  ACCESS_LIST_AGENTS_ACTION,
  ACCESS_LIST_CREDENTIALS_ACTION,
  ACCESS_LIST_RUNS_ACTION,
  ACCESS_PAUSE_ACTION,
  ACCESS_RESUME_ACTION,
  ACCESS_REVOKE_ACTION,
} from "./index.ts";
import { useAccessRead } from "./reads.ts";
import { partitionCredentials } from "./rows.ts";
export { AgentsSection } from "./agents.tsx";

const ROW_ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

function expiryLabel(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) return "no expiry";
  const days = Math.round((expiresAt - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "expires today";
  return days === 1 ? "expires tomorrow" : `expires in ${String(days)} days`;
}

function metaLine(row: PrincipalCredentials, now: number): string {
  const parts: string[] = [row.principal.kind];
  if (row.principal.origin !== undefined) parts.push(row.principal.origin);
  parts.push(`since ${new Date(row.createdAt).toLocaleDateString()}`);
  if (row.pausedAt !== undefined) {
    parts.push(`access paused ${new Date(row.pausedAt).toLocaleDateString()}`);
  }
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

function NativeServiceCredential({
  host,
  serviceId,
  machineId,
  revision,
}: {
  readonly host: SectionProps["host"];
  readonly serviceId: string;
  readonly machineId: string;
  readonly revision: number;
}): ReactElement {
  const read = useAccessRead(
    host,
    "engine.services.describeInstance",
    InstanceServiceDescriptionSchema,
    { serviceId },
    revision,
  );
  const service =
    read.state === "ready" && read.result.serviceId === serviceId ? read.result : null;
  const owner = service?.owner;
  const machine = owner?.machineId === machineId ? owner.name : machineId;
  const pluginId = service?.configuration?.pluginId;
  return (
    <>
      <span className="credential-inspection-note">
        Native service · {serviceId} · owned by {machine}
      </span>
      <span className="credential-agent-links">
        {pluginId === undefined ? (
          <span className="credential-inspection-note">
            {read.state === "loading"
              ? "Loading Plugins link…"
              : read.state === "failed"
                ? read.message
                : "Plugins link unavailable"}
          </span>
        ) : (
          <Chip
            className="credential-inspection-link"
            aria-label={`Open native service ${serviceId} in Plugins`}
            onClick={() => host.navigate(formatManifoldUri({ kind: "plugin", pluginId }))}
          >
            Plugins
          </Chip>
        )}
      </span>
    </>
  );
}

/** Credentials include managed services; the separately authorized Agents index owns runs. */
export function SessionsSection({ host }: SectionProps): ReactElement {
  const [authority, setAuthority] = useState({
    client: host.client,
    viewer: host.principal.id,
    generation: 0,
  });
  if (authority.client !== host.client || authority.viewer !== host.principal.id) {
    setAuthority({
      client: host.client,
      viewer: host.principal.id,
      generation: authority.generation + 1,
    });
    return <span className="sidebar-section-empty">Loading credentials…</span>;
  }
  return <CredentialSessions key={authority.generation} host={host} />;
}

function CredentialSessions({ host }: SectionProps): ReactElement {
  const caps = host.client.selfCaps();
  const mayRevoke = caps.includes("*") || caps.includes("tokens:mint");
  const [revision, setRevision] = useState(0);
  const read = useAccessRead(
    host,
    ACCESS_LIST_CREDENTIALS_ACTION,
    CredentialsResponseSchema,
    {},
    revision,
  );
  const agents = useAccessRead(
    host,
    ACCESS_LIST_AGENTS_ACTION,
    ListAgentsResultSchema,
    {},
    revision,
  );
  const runs = useAccessRead(host, ACCESS_LIST_RUNS_ACTION, ListRunsResultSchema, {}, revision);
  const [failure, setFailure] = useState<string | null>(null);
  // Revocation fences live sockets, so the first press must disclose what the second does.
  const [armedId, setArmedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingAccessId, setPendingAccessId] = useState<string | null>(null);
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const revoke = async (principalId: string): Promise<void> => {
    setPendingId(principalId);
    setFailure(null);
    try {
      const outcome = await host.client.action(ACCESS_REVOKE_ACTION, { principalId });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const parsed = RevokeResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        setFailure("The credentials were withdrawn, but the count could not be read");
        return;
      }
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not withdraw the credentials");
    } finally {
      setPendingId(null);
      setArmedId(null);
    }
  };
  const setAccessPaused = async (row: PrincipalCredentials): Promise<void> => {
    const pausing = row.pausedAt === undefined;
    setPendingAccessId(row.principal.id);
    setFailure(null);
    try {
      const outcome = await host.client.action(
        pausing ? ACCESS_PAUSE_ACTION : ACCESS_RESUME_ACTION,
        { principalId: row.principal.id },
      );
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const parsed = PrincipalAccessPauseResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        setFailure(
          pausing
            ? "Access was paused, but the durable state could not be read"
            : "Access was resumed, but the durable state could not be read",
        );
        return;
      }
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setFailure(
        reason instanceof Error
          ? reason.message
          : pausing
            ? "Could not pause access"
            : "Could not resume access",
      );
    } finally {
      setPendingAccessId(null);
    }
  };
  const rows = read.state === "ready" ? read.result.principals : [];
  const parts = partitionCredentials(rows);
  const live = rows.reduce((total, row) => total + row.sessions.length, 0);
  const renderRow = (row: PrincipalCredentials): ReactElement => {
    const self = row.principal.id === host.principal.id;
    const armed = armedId === row.principal.id;
    const agent =
      row.principal.kind === "agent" && agents.state === "ready"
        ? agents.result.agents.find((entry) => entry.principalId === row.principal.id)
        : undefined;
    const activeRuns =
      agent === undefined || runs.state !== "ready"
        ? []
        : runs.result.runs.filter(
            (run) =>
              run.agentId === agent.agentId &&
              (run.state === "active" ||
                run.state === "pending_policy" ||
                run.state === "policy_stale"),
          );
    const missingAgent =
      row.principal.kind !== "agent"
        ? "No Agent linked"
        : agents.state === "loading"
          ? "Loading Agent link…"
          : agents.state === "failed"
            ? "Agent link unavailable"
            : agents.result.truncated
              ? "Agent link outside this page"
              : "No Agent linked";
    return (
      <div
        className={`credential-row${self ? " is-self" : ""}`}
        key={row.principal.id}
        data-principal={row.principal.id}
      >
        <span
          className="credential-pip"
          style={{ background: row.principal.color }}
          aria-hidden="true"
        />
        <span className="credential-name">
          <strong>{row.principal.name}</strong>
          {row.principal.kind === "service" ? (
            <>
              <span className="credential-meta">
                {metaLine(row, read.state === "ready" ? read.observedAt : 0)}
              </span>
              {row.serviceId === undefined || row.machineId === undefined ? (
                <span className="credential-inspection-note">
                  Native service · identity unavailable
                </span>
              ) : (
                <NativeServiceCredential
                  host={host}
                  serviceId={row.serviceId}
                  machineId={row.machineId}
                  revision={revision}
                />
              )}
            </>
          ) : (
            <>
              <span className="credential-meta">
                {metaLine(row, read.state === "ready" ? read.observedAt : 0)}
              </span>
              <span className="credential-agent-links">
                {agent === undefined ? (
                  <span className="credential-inspection-note">{missingAgent}</span>
                ) : (
                  <>
                    <Chip
                      className="credential-inspection-link"
                      aria-label={`Open Agent ${agent.name}`}
                      onClick={() =>
                        host.navigate(formatManifoldUri({ kind: "agent", agentId: agent.agentId }))
                      }
                    >
                      Agent · {agent.name}
                    </Chip>
                    {activeRuns.map((run) => (
                      <Chip
                        key={run.id}
                        className="credential-inspection-link"
                        aria-label={`Open run ${run.id}`}
                        onClick={() =>
                          host.navigate(formatManifoldUri({ kind: "run", runId: run.id }))
                        }
                      >
                        Run · {run.id}
                      </Chip>
                    ))}
                    {activeRuns.length === 0 ? (
                      <span className="credential-inspection-note">
                        {runs.state !== "ready"
                          ? "Run links unavailable"
                          : runs.result.truncated
                            ? "No active run in this page"
                            : "No active run linked"}
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            </>
          )}
        </span>
        <span className="credential-controls">
          {!self && row.sessions.length > 0 ? (
            <button
              className="credential-access-toggle"
              type="button"
              data-action={row.pausedAt === undefined ? ACCESS_PAUSE_ACTION : ACCESS_RESUME_ACTION}
              data-testid="credential-access-toggle"
              data-paused={row.pausedAt !== undefined}
              aria-label={`${row.pausedAt === undefined ? "Pause" : "Resume"} access for ${row.principal.name}`}
              title={`${row.pausedAt === undefined ? "Pause" : "Resume"} access for ${row.principal.name}`}
              disabled={pendingAccessId !== null || pendingId !== null}
              onClick={() => void setAccessPaused(row)}
            >
              {row.pausedAt === undefined ? "Pause access" : "Resume access"}
            </button>
          ) : null}
          {row.principal.kind !== "service" && mayRevoke && row.sessions.length > 0 ? (
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
                  ? `Press again to withdraw ${String(row.sessions.length)} credential(s)${self ? " — including this browser's" : ""}`
                  : `Withdraw every credential of ${row.principal.name}`
              }
              disabled={pendingId !== null || pendingAccessId !== null}
              onBlur={() => {
                if (armed) setArmedId(null);
              }}
              onClick={() => {
                if (!armed) setArmedId(row.principal.id);
                else void revoke(row.principal.id);
              }}
            >
              <ControlIcon kind="revoke" {...ROW_ICON} />
            </button>
          ) : null}
        </span>
      </div>
    );
  };
  return (
    <Stack className="sidebar-section-content" gap="0.35rem">
      <div className="credential-agent-toolbar">
        <span className="sidebar-section-count">
          {live}/{rows.length} live
        </span>
        <Chip
          data-action={ACCESS_LIST_CREDENTIALS_ACTION}
          onClick={() => setRevision((current) => current + 1)}
        >
          Refresh
        </Chip>
      </div>
      {failure === null ? null : (
        <span className="credential-failure" role="alert">
          {failure}
        </span>
      )}
      {read.state === "failed" ? (
        <span className="credential-failure" role="alert">
          {read.message}
        </span>
      ) : null}
      {agents.state === "failed" ? (
        <span className="credential-failure" role="alert">
          {agents.message}
        </span>
      ) : null}
      {runs.state === "failed" ? (
        <span className="credential-failure" role="alert">
          {runs.message}
        </span>
      ) : null}
      <Stack gap="0.2rem" data-testid="credentials-rail">
        {read.state === "loading" ? (
          <span className="sidebar-section-empty" role="status">
            Loading credentials…
          </span>
        ) : rows.length === 0 ? (
          <span className="sidebar-section-empty">No credentials to show</span>
        ) : (
          <>
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
