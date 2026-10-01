import type { SectionProps } from "@manifold/plugin";
import { FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import {
  ContainersResponseSchema,
  MANIFOLD_ROOT_URI,
  MintTokenV2RequestSchema,
  TokenGrantV2Schema,
  formatManifoldUri,
  type AskableCap,
  type MachineSummary,
} from "@manifold/protocol";
import { Chip, Stack } from "@manifold/ui";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { ACCESS_MINT_TOKEN_V2_ACTION } from "./index.ts";
import { useAccessRead } from "./reads.ts";

const WORKING_CAPS: readonly AskableCap[] = [
  "containers:read",
  "containers:write",
  "scenes:write",
  "terminals:spawn",
  "terminals:write",
];

/** Human automation delegates shell birth separately from the existing terminal-control rights. */
export function ShellAutomation({
  host,
  changed,
}: SectionProps & { readonly changed: () => void }): ReactElement | null {
  const subscribe = useCallback(
    (notify: () => void) => host.client.onAuthorityChange(notify),
    [host.client],
  );
  const snapshot = useCallback(
    () => `${host.client.status}:${host.client.workspaceCaps().join(",")}`,
    [host.client],
  );
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const currentMayMint = (): boolean =>
    host.principal.kind === "human" &&
    host.client.status === "open" &&
    host.client.workspaceCaps().some((cap) => cap === "*" || cap === "tokens:mint");
  const mayMint = currentMayMint();
  const [lastMayMint, setLastMayMint] = useState(mayMint);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"composition" | "workspace">("composition");
  const [compositionId, setCompositionId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const epoch = useRef(0);
  if (lastMayMint !== mayMint) {
    setLastMayMint(mayMint);
    if (!mayMint) {
      epoch.current++;
      setToken(null);
      setPending(false);
      setOpen(false);
    }
  }
  const fetchMachines = useCallback(() => host.client.machines(), [host.client]);
  const { value: machines } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    FALLBACK_POLL_MS,
    {
      key: "core.machines.list",
      initial: null,
      topics: host.topics.machines,
      events: host.client,
      requiresWorkspaceEvents: true,
    },
  );
  const containers = useAccessRead(host, "core.index.listContainers", ContainersResponseSchema, {});
  useLayoutEffect(() => {
    const off = host.client.onAuthorityChange(() => {
      epoch.current++;
      setPending(false);
      if (host.client.status !== "open") {
        setToken(null);
        setOpen(false);
        return;
      }
      const caps = host.client.workspaceCaps();
      if (!caps.includes("*") && !caps.includes("tokens:mint")) {
        setToken(null);
        setOpen(false);
      }
    });
    return () => {
      epoch.current++;
      off();
    };
  }, [host.client]);
  if (!mayMint) return null;
  const compositions =
    containers.state === "ready"
      ? containers.result.containers.filter((container) => container.discipline === "composition")
      : [];
  const selectedMachine = machines?.find((machine) => machine.id === machineId);
  const eligible =
    selectedMachine !== undefined &&
    selectedMachine.revoked !== true &&
    selectedMachine.terminalExecution === "unconfined";
  const selectedComposition = compositions.find((container) => container.id === compositionId);
  const ready = eligible && (mode === "workspace" || selectedComposition !== undefined);
  return (
    <Stack gap="0.4rem" data-testid="shell-automation">
      <Chip
        aria-expanded={open}
        onClick={() => {
          epoch.current++;
          setPending(false);
          setToken(null);
          setCopied(false);
          setOpen((current) => !current);
        }}
      >
        Delegate shell automation
      </Chip>
      {!open ? null : (
        <form
          className="credential-agent-form"
          aria-label="Delegate shell automation"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !ready || !currentMayMint()) return;
            const data = new FormData(event.currentTarget);
            const target =
              mode === "workspace"
                ? MANIFOLD_ROOT_URI
                : formatManifoldUri({ kind: "container", containerId: compositionId });
            const request = MintTokenV2RequestSchema.safeParse({
              principalId: host.principal.id,
              scope: [
                { target, reach: "subtree", caps: [...WORKING_CAPS] },
                {
                  target: formatManifoldUri({ kind: "machine", machineId }),
                  reach: "node",
                  caps: ["machines:shell"],
                },
              ],
              ...(mode === "composition" ? { containerId: compositionId } : {}),
              expiresAt: new Date(String(data.get("expires") ?? "")).getTime(),
            });
            if (!request.success) {
              setFailure("Choose a valid finite credential expiry and exact placement/account.");
              return;
            }
            const admittedEpoch = ++epoch.current;
            setPending(true);
            setFailure(null);
            setToken(null);
            setCopied(false);
            void (async () => {
              try {
                const outcome = await host.client.action(ACCESS_MINT_TOKEN_V2_ACTION, request.data);
                if (epoch.current !== admittedEpoch || !currentMayMint()) return;
                if (!outcome.ok) {
                  setFailure(outcome.denial.message);
                  return;
                }
                const parsed = TokenGrantV2Schema.safeParse(outcome.result);
                if (!parsed.success) {
                  setFailure(
                    "Issuance returned an unreadable credential; its custody is unconfirmed.",
                  );
                  return;
                }
                setToken(parsed.data.token);
                changed();
              } catch (reason: unknown) {
                if (epoch.current === admittedEpoch)
                  setFailure(
                    reason instanceof Error ? reason.message : "Credential issuance failed.",
                  );
              } finally {
                if (epoch.current === admittedEpoch) setPending(false);
              }
            })();
          }}
        >
          <Stack gap="0.4rem">
            <label>
              Placement authority
              <select
                value={mode}
                disabled={pending || token !== null}
                onChange={(event) =>
                  setMode(event.currentTarget.value === "workspace" ? "workspace" : "composition")
                }
              >
                <option value="composition">One existing composition</option>
                <option value="workspace">Workspace compositions and canvas homes</option>
              </select>
            </label>
            {mode !== "composition" ? null : (
              <label>
                Existing composition
                <select
                  value={compositionId}
                  disabled={pending || token !== null}
                  onChange={(event) => setCompositionId(event.currentTarget.value)}
                >
                  <option value="">Select a composition</option>
                  {compositions.map((container) => (
                    <option key={container.id} value={container.id}>
                      {container.name} · {container.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Exact enrolled account
              <select
                value={machineId}
                disabled={pending || token !== null}
                onChange={(event) => setMachineId(event.currentTarget.value)}
              >
                <option value="">Select an account</option>
                {(machines ?? []).map((machine) => (
                  <option
                    key={machine.id}
                    value={machine.id}
                    disabled={
                      machine.revoked === true || machine.terminalExecution !== "unconfined"
                    }
                  >
                    {machine.name} · {machine.id}
                    {machine.online ? "" : " · offline"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Credential expires
              <input
                name="expires"
                type="datetime-local"
                required
                disabled={pending || token !== null}
              />
            </label>
            <span className="credential-inspection-note">
              {mode === "workspace"
                ? "Working rights cover workspace composition and independent canvas homes."
                : "Working rights cover this composition's tiles, not independent canvas homes."}{" "}
              Shell creation/restart is limited to the exact selected endpoint ID. Names and host
              groupings grant no authority.
            </span>
            <span className="credential-inspection-note">
              Working rights: {WORKING_CAPS.join(", ")}. Terminal write/control is separate and may
              reach existing terminals on other accounts inside this placement scope. This is not
              blanket machine isolation or a sandbox; shell processes have the selected OS account's
              authority. Revocation cannot undo prior filesystem effects.
            </span>
            {containers.state === "failed" ? <span role="alert">{containers.message}</span> : null}
            {failure === null ? null : (
              <span className="credential-failure" role="alert">
                {failure}
              </span>
            )}
            <button
              className="credential-agent-control"
              type="submit"
              data-action={ACCESS_MINT_TOKEN_V2_ACTION}
              disabled={pending || !ready || token !== null}
            >
              {pending ? "Delegating…" : "Mint finite automation credential"}
            </button>
            {token === null ? null : (
              <Stack gap="0.4rem" data-testid="shell-automation-credential">
                <span className="credential-inspection-note">
                  Shown once. Provision through the launcher's owning credential flow; no
                  token-bearing command is generated.
                </span>
                <label>
                  Automation credential
                  <input
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <Chip
                  onClick={() => {
                    const captured = epoch.current;
                    void navigator.clipboard
                      .writeText(token)
                      .then(() => {
                        if (epoch.current === captured) setCopied(true);
                      })
                      .catch(() => {
                        if (epoch.current === captured)
                          setFailure(
                            "Clipboard unavailable; select the read-only credential manually.",
                          );
                      });
                  }}
                >
                  {copied ? "Copied" : "Copy credential"}
                </Chip>
                <Chip
                  onClick={() => {
                    epoch.current++;
                    setToken(null);
                    setCopied(false);
                  }}
                >
                  Hide credential
                </Chip>
              </Stack>
            )}
          </Stack>
        </form>
      )}
    </Stack>
  );
}
