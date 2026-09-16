import type { SectionProps } from "@manifold/plugin";
import {
  ListRunsResultSchema,
  CreateRunResultSchema,
  FinishAgentRunResultSchema,
  GetAgentResultSchema,
  LaunchRunResultSchema,
  ListAgentsResultSchema,
  ListHarnessesResultSchema,
  RegisterAgentResultSchema,
  formatManifoldUri,
  type Agent,
  type ListRunsResult,
  type RegisterAgentRequest,
} from "@manifold/protocol";
import { Chip, Disclosure, KeyValueList, KeyValueRow, Stack } from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  ACCESS_CREATE_RUN_ACTION,
  ACCESS_DISABLE_AGENT_ACTION,
  ACCESS_ENABLE_AGENT_ACTION,
  ACCESS_FINISH_AGENT_RUN_ACTION,
  ACCESS_GET_AGENT_ACTION,
  ACCESS_INSPECT_RUN_ACTION,
  ACCESS_LAUNCH_RUN_ACTION,
  ACCESS_LIST_AGENTS_ACTION,
  ACCESS_LIST_HARNESSES_ACTION,
  ACCESS_LIST_RUNS_ACTION,
  ACCESS_REGISTER_AGENT_ACTION,
  ACCESS_RETIRE_AGENT_ACTION,
} from "./index.ts";
import { AgentRegistration } from "./agent-form.tsx";
import { useAccessRead } from "./reads.ts";
import { InspectionFold, NativeReference, RunInspector, inspectionTime } from "./runs.tsx";

type RunSummary = ListRunsResult["runs"][number];

/** Replace the entire privileged subtree when the viewer or its client changes. */
export function AgentsSection({ host }: SectionProps): ReactElement {
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
    return <span className="sidebar-section-empty">Loading Agents…</span>;
  }
  return <AgentIndex key={authority.generation} host={host} />;
}

function AgentIndex({ host }: SectionProps): ReactElement {
  const [revision, setRevision] = useState(0);
  const [registering, setRegistering] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ agentId?: string; runId?: string } | null>(null);
  const [seenRef, setSeenRef] = useState<typeof host.requestedRef>(null);
  const agents = useAccessRead(
    host,
    ACCESS_LIST_AGENTS_ACTION,
    ListAgentsResultSchema,
    {},
    revision,
  );
  const runs = useAccessRead(host, ACCESS_LIST_RUNS_ACTION, ListRunsResultSchema, {}, revision);
  const harnesses = useAccessRead(
    host,
    ACCESS_LIST_HARNESSES_ACTION,
    ListHarnessesResultSchema,
    {},
  );
  const mayRegister = agents.state === "ready" && agents.result.canRegister;
  const requestedRef = host.requestedRef;
  if (seenRef !== requestedRef) {
    setSeenRef(requestedRef);
    if (requestedRef?.kind === "agent") setSelection({ agentId: requestedRef.agentId });
    if (requestedRef?.kind === "run") setSelection({ runId: requestedRef.runId });
  }
  const register = async (request: RegisterAgentRequest): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      const outcome = await host.client.action(ACCESS_REGISTER_AGENT_ACTION, request);
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      const parsed = RegisterAgentResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        setFailure("The registered Agent could not be read.");
        return;
      }
      setSelection({ agentId: parsed.data.agent.agentId });
      setRegistering(false);
      setRevision((current) => current + 1);
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "The Agent could not be registered.");
    } finally {
      setPending(false);
    }
  };
  const latestRuns = new Map<string, RunSummary>();
  if (runs.state === "ready") {
    for (const run of runs.result.runs) {
      const previous = latestRuns.get(run.agentId);
      if (previous === undefined || previous.createdAt < run.createdAt)
        latestRuns.set(run.agentId, run);
    }
  }
  return (
    <Stack
      className="sidebar-section-content credential-agents"
      gap="0.45rem"
      data-testid="agents-rail"
    >
      <div className="credential-agent-toolbar">
        <span className="sidebar-section-count">
          {agents.state === "ready" ? `${String(agents.result.agents.length)} Agents` : "Agents"}
        </span>
        <Chip
          data-action={ACCESS_LIST_AGENTS_ACTION}
          onClick={() => setRevision((current) => current + 1)}
        >
          Refresh
        </Chip>
        {mayRegister ? (
          <Chip
            data-action={ACCESS_REGISTER_AGENT_ACTION}
            aria-expanded={registering}
            onClick={() => setRegistering((current) => !current)}
          >
            Register
          </Chip>
        ) : null}
      </div>
      {failure === null ? null : (
        <span className="credential-failure" role="alert">
          {failure}
        </span>
      )}
      {registering && mayRegister ? (
        harnesses.state === "ready" ? (
          <AgentRegistration
            harnesses={harnesses.result.harnesses}
            pending={pending}
            register={register}
          />
        ) : harnesses.state === "failed" ? (
          <span role="alert" className="credential-failure">
            {harnesses.message}
          </span>
        ) : (
          <span role="status">Loading harnesses…</span>
        )
      ) : null}
      {selection?.runId === undefined ? null : (
        <Stack gap="0.4rem">
          <Chip onClick={() => setSelection(null)}>Back to Agents</Chip>
          <RunInspector key={selection.runId} host={host} runId={selection.runId} />
        </Stack>
      )}
      {agents.state === "loading" ? (
        <span className="sidebar-section-empty" role="status">
          Loading Agents…
        </span>
      ) : agents.state === "failed" ? (
        <span className="credential-failure" role="alert">
          {agents.message}
        </span>
      ) : (
        <>
          {agents.result.agents.length === 0 ? (
            <span className="sidebar-section-empty">No Agents to show</span>
          ) : null}
          {agents.result.agents.map((agent) => {
            const last = latestRuns.get(agent.agentId);
            const lastLabel =
              runs.state !== "ready"
                ? "unavailable"
                : last === undefined
                  ? runs.result.truncated
                    ? "outside this page"
                    : "none"
                  : `${last.state} · ${inspectionTime(last.createdAt)}`;
            const selected = selection?.agentId === agent.agentId;
            return (
              <Disclosure
                key={agent.agentId}
                className="credential-agent"
                data-agent-id={agent.agentId}
                open={selected}
                onOpenChange={(open) => setSelection(open ? { agentId: agent.agentId } : null)}
                headerClassName="credential-agent-heading"
                header={
                  <span className="credential-agent-summary">
                    <span className="credential-agent-title">
                      <strong>{agent.name}</strong>
                      <Chip className="credential-agent-state" data-state={agent.state}>
                        {agent.state}
                      </Chip>
                    </span>
                    <span className="credential-inspection-note">
                      {agent.sponsorPrincipalId} · {agent.harness}
                    </span>
                    <span className="credential-inspection-note">
                      {agent.activeRuns} active runs · last {lastLabel}
                    </span>
                  </span>
                }
              >
                {selected ? (
                  <AgentDetail
                    host={host}
                    agentId={agent.agentId}
                    revision={revision}
                    changed={() => setRevision((current) => current + 1)}
                  />
                ) : null}
              </Disclosure>
            );
          })}
          {agents.result.truncated ? (
            <span className="sidebar-section-empty">Showing the newest 100 visible Agents.</span>
          ) : null}
          {selection?.agentId === undefined ||
          agents.result.agents.some((agent) => agent.agentId === selection.agentId) ? null : (
            <AgentDetail
              key={selection.agentId}
              host={host}
              agentId={selection.agentId}
              revision={revision}
              changed={() => setRevision((current) => current + 1)}
            />
          )}
        </>
      )}
      {runs.state === "failed" ? (
        <span className="credential-failure" role="alert">
          {runs.message}
        </span>
      ) : null}
    </Stack>
  );
}

function AgentDetail({
  host,
  agentId,
  revision,
  changed,
}: SectionProps & {
  readonly agentId: string;
  readonly revision: number;
  readonly changed: () => void;
}): ReactElement {
  const read = useAccessRead(
    host,
    ACCESS_GET_AGENT_ACTION,
    GetAgentResultSchema,
    { agentId },
    revision,
  );
  if (read.state === "loading") return <span role="status">Loading Agent…</span>;
  if (read.state === "failed")
    return (
      <span className="credential-failure" role="alert">
        {read.message}
      </span>
    );
  const agent = read.result.agent;
  return (
    <Stack className="credential-agent-detail" gap="0.5rem">
      <KeyValueList>
        <KeyValueRow label="Purpose">{agent.purpose}</KeyValueRow>
        <KeyValueRow label="Sponsor">{agent.sponsorPrincipalId}</KeyValueRow>
        <KeyValueRow label="Principal">{agent.principalId}</KeyValueRow>
        <KeyValueRow label="Harness">{agent.harness}</KeyValueRow>
        <KeyValueRow label="Policy">
          {agent.policyRevisionAcknowledged ?? "Not acknowledged"}
        </KeyValueRow>
      </KeyValueList>
      <InspectionFold title="Standing grant and context">
        <KeyValueList>
          <KeyValueRow label="Capabilities">{agent.grant.caps.join(", ")}</KeyValueRow>
          <KeyValueRow label="Targets">
            {agent.grant.targets.map((target) => (
              <NativeReference key={target} host={host} uri={target} />
            ))}
          </KeyValueRow>
          <KeyValueRow label="Reach">{agent.grant.reach}</KeyValueRow>
          <KeyValueRow label="Run lifetime">
            {agent.grant.maxRunLifetimeMs / 60_000} minutes maximum
          </KeyValueRow>
          <KeyValueRow label="Delegation">
            Depth {agent.grant.delegation.maxDepth} · {agent.grant.delegation.maxDescendants}{" "}
            descendants
          </KeyValueRow>
          <KeyValueRow label="Grant expiry">{inspectionTime(agent.grant.expiresAt)}</KeyValueRow>
          <KeyValueRow label="Instructions">
            {agent.context.instructions ?? "None attached"}
          </KeyValueRow>
          <KeyValueRow label="Profile">
            <pre>{JSON.stringify(agent.context.profile, null, 2)}</pre>
          </KeyValueRow>
        </KeyValueList>
      </InspectionFold>
      {read.result.canManage ? (
        <AgentControls host={host} agent={agent} changed={changed} />
      ) : (
        <span className="credential-inspection-note">Only the sponsor can manage this Agent.</span>
      )}
      <AgentRuns host={host} agentId={agentId} revision={revision} />
    </Stack>
  );
}

function AgentControls({
  host,
  agent,
  changed,
}: SectionProps & { readonly agent: Agent; readonly changed: () => void }): ReactElement {
  const [pending, setPending] = useState(false);
  const [armed, setArmed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [machineId, setMachineId] = useState("");
  const [unconfirmedRunId, setUnconfirmedRunId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const control = async (action: string): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      const outcome = await host.client.action(action, { agentId: agent.agentId });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      changed();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "The Agent could not be changed.");
    } finally {
      setPending(false);
      setArmed(false);
    }
  };
  const start = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      const created = await host.client.action(ACCESS_CREATE_RUN_ACTION, {
        agentId: agent.agentId,
        target: {
          machineId: machineId.trim(),
          ...(host.containerId === null ? {} : { containerId: host.containerId }),
        },
      });
      if (!mounted.current) return;
      if (!created.ok) {
        setFailure(created.denial.message);
        return;
      }
      const parsed = CreateRunResultSchema.safeParse(created.result);
      if (!parsed.success) {
        setFailure("The created run could not be read. Refresh the Agent before trying again.");
        return;
      }
      setUnconfirmedRunId(parsed.data.run.id);
      const launched = await host.client.action(ACCESS_LAUNCH_RUN_ACTION, {
        runId: parsed.data.run.id,
        target: {
          machineId: machineId.trim(),
          ...(host.containerId === null ? {} : { containerId: host.containerId }),
        },
      });
      if (!mounted.current) return;
      if (!launched.ok) {
        setFailure(launched.denial.message);
        return;
      }
      const launch = LaunchRunResultSchema.safeParse(launched.result);
      if (!launch.success) {
        setFailure("The harness launch could not be read.");
        return;
      }
      const terminal = await host.client.openTerminal({
        elementId: crypto.randomUUID(),
        machineId: launch.data.destination.machineId,
        runtime: launch.data.runtime,
        placement: "tile",
      });
      if (!mounted.current) return;
      setUnconfirmedRunId(null);
      host.navigate(formatManifoldUri({ kind: "terminal", terminalId: terminal.id }));
      changed();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "The run could not be opened.");
    } finally {
      setPending(false);
    }
  };
  const cancel = async (): Promise<void> => {
    if (unconfirmedRunId === null) return;
    setPending(true);
    try {
      const outcome = await host.client.action(ACCESS_FINISH_AGENT_RUN_ACTION, {
        runId: unconfirmedRunId,
        outcome: "cancelled",
      });
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return;
      }
      if (!FinishAgentRunResultSchema.safeParse(outcome.result).success) {
        setFailure("Run cancellation returned an unreadable result. Cleanup is unconfirmed.");
        return;
      }
      setUnconfirmedRunId(null);
      changed();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Run cleanup is unconfirmed.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Stack gap="0.4rem">
      {agent.state === "retired" ? (
        <span className="credential-inspection-note">
          Retired permanently. Existing runs keep their own expiry and settlement.
        </span>
      ) : (
        <>
          <div className="credential-agent-toolbar">
            <button
              className="credential-agent-control"
              type="button"
              disabled={pending}
              data-action={
                agent.state === "disabled"
                  ? ACCESS_ENABLE_AGENT_ACTION
                  : ACCESS_DISABLE_AGENT_ACTION
              }
              onClick={() =>
                void control(
                  agent.state === "disabled"
                    ? ACCESS_ENABLE_AGENT_ACTION
                    : ACCESS_DISABLE_AGENT_ACTION,
                )
              }
            >
              {agent.state === "disabled" ? "Enable" : "Disable"}
            </button>
            <button
              className="credential-agent-control"
              type="button"
              disabled={pending}
              data-action={ACCESS_RETIRE_AGENT_ACTION}
              data-confirming={armed}
              onBlur={() => setArmed(false)}
              onClick={() => {
                if (armed) void control(ACCESS_RETIRE_AGENT_ACTION);
                else setArmed(true);
              }}
            >
              {armed ? "Confirm retire" : "Retire"}
            </button>
          </div>
          <span className="credential-inspection-note">
            {armed
              ? "Press again to retire permanently. Active runs may finish."
              : "Disable revokes active runs immediately; retire lets them finish."}
          </span>
          <label className="credential-agent-field">
            Machine ID
            <input
              value={machineId}
              onChange={(event) => setMachineId(event.target.value)}
              placeholder="Harness host machine"
            />
          </label>
          <button
            className="credential-agent-control"
            type="button"
            disabled={
              pending ||
              unconfirmedRunId !== null ||
              agent.state === "disabled" ||
              host.containerId === null ||
              machineId.trim() === ""
            }
            data-action={ACCESS_CREATE_RUN_ACTION}
            onClick={() => void start()}
          >
            {pending ? "Working…" : "Start run"}
          </button>
          {host.containerId === null ? (
            <span className="credential-inspection-note">
              Open a composition to start a run in a terminal tile.
            </span>
          ) : null}
        </>
      )}
      {failure === null ? null : (
        <span className="credential-failure" role="alert">
          {failure}
        </span>
      )}
      {unconfirmedRunId === null ? null : (
        <Stack gap="0.35rem">
          <span className="credential-inspection-note">
            Run {unconfirmedRunId} was admitted; terminal opening is unconfirmed. Cancel it here, or
            it will expire at its admitted lifetime even without policy acknowledgement.
          </span>
          <NativeReference
            host={host}
            uri={formatManifoldUri({ kind: "run", runId: unconfirmedRunId })}
          />
          <button
            className="credential-agent-control"
            type="button"
            disabled={pending}
            data-action={ACCESS_FINISH_AGENT_RUN_ACTION}
            onClick={() => void cancel()}
          >
            Cancel unconfirmed run
          </button>
        </Stack>
      )}
    </Stack>
  );
}

function AgentRuns({
  host,
  agentId,
  revision,
}: SectionProps & { readonly agentId: string; readonly revision: number }): ReactElement {
  const read = useAccessRead(
    host,
    ACCESS_LIST_RUNS_ACTION,
    ListRunsResultSchema,
    { agentId },
    revision,
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (read.state === "loading") return <span role="status">Loading runs…</span>;
  if (read.state === "failed")
    return (
      <span className="credential-failure" role="alert">
        {read.message}
      </span>
    );
  const ids = new Set(read.result.runs.map((run) => run.id));
  const children = new Map<string | null, RunSummary[]>();
  for (const run of read.result.runs) {
    const parent = run.parentRunId !== null && ids.has(run.parentRunId) ? run.parentRunId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(run);
    children.set(parent, siblings);
  }
  const renderRuns = (parent: string | null, ancestors: ReadonlySet<string>): ReactElement => (
    <ul className="credential-run-tree">
      {(children.get(parent) ?? [])
        .filter((run) => !ancestors.has(run.id))
        .map((run) => (
          <li key={run.id}>
            <button
              className="credential-agent-run"
              type="button"
              data-action={ACCESS_INSPECT_RUN_ACTION}
              aria-expanded={selected === run.id}
              aria-label={`Inspect run ${run.id}`}
              onClick={() => setSelected((current) => (current === run.id ? null : run.id))}
            >
              <strong>{run.id}</strong>
              <span>
                {run.state} · {run.activity}
              </span>
              <span>
                {run.model === undefined
                  ? "Model not reported"
                  : `${run.model.provider} / ${run.model.model}`}
              </span>
              <span>Expires {inspectionTime(run.expiresAt)}</span>
              <span>
                {run.actionCount} actions · {run.refusalCount} refusals
              </span>
            </button>
            {selected === run.id ? <RunInspector key={run.id} host={host} runId={run.id} /> : null}
            {children.has(run.id) ? renderRuns(run.id, new Set([...ancestors, run.id])) : null}
          </li>
        ))}
    </ul>
  );
  return (
    <Stack gap="0.3rem">
      <strong>Runs · {read.result.runs.length}</strong>
      {read.result.runs.length === 0 ? (
        <span className="sidebar-section-empty">No runs yet</span>
      ) : (
        renderRuns(null, new Set())
      )}
      {read.result.truncated ? (
        <span className="credential-inspection-note">
          Showing the newest 100 visible runs; older parents may be outside this page.
        </span>
      ) : null}
    </Stack>
  );
}
