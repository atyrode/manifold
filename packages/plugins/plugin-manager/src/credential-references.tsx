import type { SectionProps } from "@manifold/plugin";
import { instanceOrigin, selectedInstanceOrigin } from "@manifold/plugin/instance";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE_OPTIONS, usePolledResource } from "@manifold/plugin/hooks";
import {
  ServiceConfigurationReadSchema,
  type MachineSummary,
  type ServiceConfigurationRead,
} from "@manifold/protocol";
import { Cluster, Stack } from "@manifold/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { privateCredentialEntryBypass, type Bypass } from "@manifold/plugin/private-entry";

type Metadata = Pick<ServiceConfigurationRead, "connected" | "credentialReferences">;
const UPDATE_GUIDANCE = "Private entry is closed until the current root worker proves bypass support. Accept the ordinary workspace update activation, then check again. No worker update is activated here.";

/** Machine-wide metadata/launch source in the existing manager, never a plugin runtime form. */
export function CredentialReferences({ host }: Pick<SectionProps, "host">): ReactElement {
  const hub = instanceOrigin();
  const [machineId, setMachineId] = useState("");
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hubChanged, setHubChanged] = useState(false);
  const [bypass, setBypass] = useState<Bypass>({ phase: "checking", controller: null });
  const [bypassCheck, setBypassCheck] = useState(0);
  const requestEpoch = useRef(0);
  const { value: machines } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(),
    FALLBACK_POLL_MS,
    {
      ...MACHINES_RESOURCE_OPTIONS,
      topics: host.topics.machines,
      events: host.client,
      onError: () => setFailure("Machine metadata is currently unavailable."),
    },
  );

  useEffect(() => {
    let current = true;
    setPending(false);
    const check = (): void => {
      setBypass({ phase: "checking", controller: null });
      void privateCredentialEntryBypass().then((result) => { if (current) setBypass(result); });
    };
    check();
    const changed = (): void => {
      requestEpoch.current++;
      setMetadata(null);
      setPending(false);
      check();
    };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", changed);
    return () => {
      current = false;
      requestEpoch.current++;
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("controllerchange", changed);
    };
  }, [bypassCheck]);

  useEffect(() => {
    const changed = (): void => {
      if (selectedInstanceOrigin() === hub) return;
      requestEpoch.current++;
      setMetadata(null);
      setPending(false);
      setHubChanged(true);
      setFailure("The selected Manifold hub changed. Reload the ordinary workspace before reading or launching a reference.");
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [hub]);

  const read = async (): Promise<void> => {
    if (machineId === "" || pending || hubChanged) return;
    const stamp = ++requestEpoch.current;
    setMetadata(null);
    setPending(true);
    setFailure(null);
    try {
      // The only credential-related manager action is the existing safe metadata reader.
      const outcome = await host.client.action("engine.services.readConfiguration", { machineId });
      if (stamp !== requestEpoch.current) return;
      if (!outcome.ok) {
        setFailure("Current root and exact-machine services:configure authority are required.");
        return;
      }
      const parsed = ServiceConfigurationReadSchema.safeParse(outcome.result);
      if (!parsed.success) {
        setFailure("The configuration metadata read was refused or invalid. No private entry was opened.");
        return;
      }
      setMetadata({ connected: parsed.data.connected, credentialReferences: parsed.data.credentialReferences });
    } catch {
      if (stamp === requestEpoch.current) setFailure("The authorized metadata read could not be confirmed. No private entry was opened.");
    } finally {
      if (stamp === requestEpoch.current) setPending(false);
    }
  };

  return (
    <section className="plugin-manager-credentials" aria-labelledby="plugin-manager-credentials-title" data-testid="plugin-manager-credential-references">
      <Stack gap="0.45rem">
        <h3 id="plugin-manager-credentials-title">Native credential references</h3>
        <p>Read declared reference metadata, then open a separate, host-owned private document. The plugin manager never asks for or receives the value.</p>
        <label className="plugin-manager-install-field">
          <span>Machine for credential references</span>
          <select
            aria-label="Machine for credential references"
            value={machineId}
            disabled={hubChanged}
            onChange={(event) => {
              requestEpoch.current++;
              setMachineId(event.target.value);
              setMetadata(null);
              setPending(false);
              setFailure(null);
            }}
          >
            <option value="">Choose a machine</option>
            {machines?.map((machine) => <option key={machine.id} value={machine.id}>{machine.name} · {machine.revoked ? "revoked" : machine.online ? "online" : "offline"}</option>)}
          </select>
        </label>
        <Cluster gap="0.4rem">
          <button type="button" className="plugin-manager-filter" data-action="engine.services.readConfiguration" disabled={machineId === "" || pending || hubChanged} onClick={() => { void read(); }}>
            {pending ? "Reading metadata…" : "Read credential references"}
          </button>
          {bypass.phase === "unsupported" ? <button type="button" className="plugin-manager-filter" onClick={() => setBypassCheck((value) => value + 1)}>Check private-entry support again</button> : null}
        </Cluster>
        <p role="status">
          {bypass.phase === "checking" ? "Checking current root-worker private bypass support…" : bypass.phase === "unsupported" ? UPDATE_GUIDANCE : bypass.controller === null ? "No controlling worker: private entry will be network-only." : "The current controller explicitly supports network-only private document and asset bypass."}
        </p>
        {failure === null ? null : <p className="plugin-manager-error" role="alert">{failure}</p>}
        {metadata === null ? null : !metadata.connected ? <p role="status">No current proved native owner is connected. Private entry is closed.</p> : metadata.credentialReferences.length === 0 ? <p>No credential references are declared by this owner.</p> : (
          <ul className="plugin-manager-credential-list">
            {metadata.credentialReferences.map((reference) => (
              <li key={reference.ref}>
                <strong>{reference.ref}</strong>
                <span>{reference.available ? "Value held; explicit replacement required" : "No value held"}</span>
                <ul>
                  {reference.origins.map((origin) => {
                    const search = new URLSearchParams({ machineId, credentialRef: reference.ref, origin });
                    return (
                      <li key={origin}>
                        <code>{origin}</code>
                        {bypass.phase !== "ready" || hubChanged ? <span>Private entry unavailable</span> : (
                          <a
                            href={`/credential-entry.html?${search.toString()}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            onClick={(event) => {
                              const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
                              if (controller === bypass.controller && selectedInstanceOrigin() === hub) return;
                              event.preventDefault();
                              setMetadata(null);
                              setFailure(UPDATE_GUIDANCE);
                              setBypass({ phase: "unsupported", controller });
                            }}
                          >
                            Open private entry
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Stack>
    </section>
  );
}
