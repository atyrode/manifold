import type { PanelProps } from "@manifold/plugin";
import {
  FALLBACK_POLL_MS,
  MACHINES_RESOURCE,
  sessionUrl,
  useContainerRoute,
  usePolledResource,
} from "@manifold/plugin/hooks";
import { Cluster, ScrollRegion, Stack } from "@manifold/plugin/ui";
import { ContainerResponseSchema, type MachineSummary } from "@manifold/protocol";
import { SessionClient } from "@manifold/sdk";
import { useCallback, useState, type ReactElement } from "react";
import { codeLauncherSpikeManifest } from "./index.ts";
import { CATALOG, lanes, launchInto, modelsFor, thinkingFor, type LaunchPhases } from "./launch.ts";

/*
  THROWAWAY SPIKE — see ./index.ts. The browser half: three dependent dials, a machine picker,
  two launch buttons. What it measures is written up in docs/spikes/code-launcher.md; the
  comments here name the seams a real third-party author hits, not the product.

  No stylesheet: a plugin's skin needs a `cssFamilies` registry row (PLUGINS.md §1), and a spike
  that is never merged should not touch REGISTRY.md. Inline `style` attributes are not
  selectors, so S13 has nothing to say about them.
*/

const CREATE_CONTAINER_ACTION = "core.index.createContainer";
const CWD = "/tmp";

/**
 * A throwaway room handle into ONE composition, opened with the same bearer the engine dials
 * with (`host.token`, PLUGINS.md §Host services). This is the seam the docs do not spell out for
 * a PANEL: `HostServices.client` is a `SessionHandle` with no `openTerminal`, and
 * `host.authoring` is null unless the mounted renderer publishes one — so a panel that wants
 * to birth a terminal has to open its own channel exactly as a container renderer does
 * (compositions/src/composition-view.tsx:180-182, an engine read).
 */
async function joinComposition(token: string, containerId: string): Promise<SessionClient> {
  const client = new SessionClient({ url: sessionUrl(), containerId, token });
  await client.connect();
  return client;
}

export function LauncherPanel({ host }: PanelProps): ReactElement {
  const route = useContainerRoute();
  const fetchMachines = useCallback(() => host.client.machines(), [host.client]);
  const { value: machines } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
    },
  );
  const online = (machines ?? []).filter((machine) => machine.online);

  const [lane, setLane] = useState<string>(lanes(CATALOG)[0] ?? "");
  const models = modelsFor(CATALOG, lane);
  const [model, setModel] = useState<string>(models[0] ?? "");
  const modelInLane = models.includes(model) ? model : (models[0] ?? "");
  const thinkingLevels = thinkingFor(CATALOG, lane, modelInLane);
  const [thinking, setThinking] = useState<string>(thinkingLevels[0] ?? "");
  const thinkingInModel = thinkingLevels.includes(thinking) ? thinking : (thinkingLevels[0] ?? "");
  const [machineId, setMachineId] = useState<string>("");
  const chosenMachine = online.find((m) => m.id === machineId) ?? online[0] ?? null;

  const [log, setLog] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const report = useCallback((line: string) => setLog((prior) => [...prior, line].slice(-8)), []);

  const command = `echo LAUNCH lane=${lane} model=${modelInLane} thinking=${thinkingInModel}`;
  const viewedComposition =
    host.containerId !== null && route.routedDiscipline === "composition" ? host.containerId : null;

  const launch = async (containerId: string): Promise<LaunchPhases | null> => {
    if (chosenMachine === null) {
      report("no online machine");
      return null;
    }
    const client = await joinComposition(host.token, containerId);
    try {
      return await launchInto(client, { machineId: chosenMachine.id, cwd: CWD, command }, report);
    } finally {
      // The PTY is server-owned; the lease is per PRINCIPAL (terminal-broker.ts:857), so the
      // viewer in the composition — this same principal — keeps typing rights after this
      // throwaway channel closes.
      client.close();
    }
  };

  const launchHere = async (): Promise<void> => {
    if (viewedComposition === null) return;
    setBusy(true);
    setLog([`launch into the composition in view (${viewedComposition.slice(0, 8)}…)`]);
    try {
      await launch(viewedComposition);
    } catch (reason: unknown) {
      report(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const launchNew = async (): Promise<void> => {
    setBusy(true);
    setLog(["create a composition, navigate, launch"]);
    try {
      const t0 = performance.now();
      const outcome = await host.client.action(CREATE_CONTAINER_ACTION, {
        name: `code ${lane}/${modelInLane.split("/")[1] ?? modelInLane}`,
        discipline: "composition",
      });
      if (!outcome.ok) {
        report(`createContainer refused: ${outcome.denial.rule}: ${outcome.denial.message}`);
        return;
      }
      const container = ContainerResponseSchema.parse(outcome.result).container;
      report(
        `composition ${container.id.slice(0, 8)}… in ${String(Math.round(performance.now() - t0))} ms`,
      );
      host.navigate(`manifold://container/${container.id}`);
      await launch(container.id);
    } catch (reason: unknown) {
      report(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollRegion style={{ height: "100%" }}>
      <Stack gap="0.6rem" style={{ padding: "0.75rem" }} data-plugin={codeLauncherSpikeManifest.id}>
        <strong
          style={{ fontSize: "0.85rem", letterSpacing: "0.04em", textTransform: "uppercase" }}
        >
          code · launch (spike)
        </strong>
        <Dial
          label="lane"
          value={lane}
          options={lanes(CATALOG)}
          onChange={(next) => {
            setLane(next);
            const firstModel = modelsFor(CATALOG, next)[0] ?? "";
            setModel(firstModel);
            setThinking(thinkingFor(CATALOG, next, firstModel)[0] ?? "");
          }}
        />
        <Dial
          label="model"
          value={modelInLane}
          options={models}
          onChange={(next) => {
            setModel(next);
            setThinking(thinkingFor(CATALOG, lane, next)[0] ?? "");
          }}
        />
        <Dial
          label="thinking"
          value={thinkingInModel}
          options={thinkingLevels}
          onChange={setThinking}
        />
        <Dial
          label="machine"
          value={chosenMachine?.id ?? ""}
          options={online.map((m) => m.id)}
          labels={Object.fromEntries(online.map((m) => [m.id, m.name]))}
          onChange={setMachineId}
        />
        <code style={{ fontSize: "0.75rem", overflowWrap: "anywhere" }}>{command}</code>
        <Cluster gap="0.4rem">
          <button
            className="primary-button"
            type="button"
            disabled={busy || viewedComposition === null || chosenMachine === null}
            title={
              viewedComposition === null
                ? "Open a composition first: the workspace tree cannot hold a terminal leaf"
                : "Open the terminal as a tile of the composition in view"
            }
            onClick={() => void launchHere()}
          >
            Launch here
          </button>
          <button
            className="primary-button"
            type="button"
            data-action={CREATE_CONTAINER_ACTION}
            disabled={busy || chosenMachine === null}
            title="Create a composition, navigate to it, open the terminal there"
            onClick={() => void launchNew()}
          >
            Launch in new composition
          </button>
        </Cluster>
        {log.length > 0 ? (
          <ol style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.75rem", opacity: 0.85 }}>
            {log.map((line, index) => (
              <li key={`${String(index)}-${line}`} style={{ overflowWrap: "anywhere" }}>
                {line}
              </li>
            ))}
          </ol>
        ) : null}
      </Stack>
    </ScrollRegion>
  );
}

function Dial({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly onChange: (next: string) => void;
}): ReactElement {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "5.5rem 1fr",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ minWidth: 0 }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels?.[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The registration the web assembly attaches (`packages/web/src/assembly.ts`). */
export const codeLauncherSpikeWebPlugin = {
  id: codeLauncherSpikeManifest.id,
  panels: { launcher: LauncherPanel },
};
