import "./styles.css";
import type { SectionProps } from "@manifold/plugin";
import { ControlIcon, Disclosure, Stack } from "@manifold/plugin/ui";
import {
  CredentialsResponseSchema,
  RevokeResultSchema,
  type PrincipalCredentials,
} from "@manifold/protocol";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { ACCESS_LIST_CREDENTIALS_ACTION, ACCESS_REVOKE_ACTION } from "./index.ts";
import { partitionCredentials } from "./rows.ts";

/**
 * THE CREDENTIAL LIST (ADR 0019 §3) — "which browsers hold my key", made answerable and
 * actionable in the workspace.
 *
 * Before this section the data existed and nothing could reach it: `GET /api/introspect`
 * published principals to a root caller and nothing else did, so a human could not look and
 * neither could an agent. What is drawn here is `core.access.listCredentials`, narrowed by
 * the server to exactly the principals this caller could revoke, beside the revoke door that
 * already existed.
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
          <strong>{row.principal.name}</strong>
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
