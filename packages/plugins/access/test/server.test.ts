import { describe, expect, test } from "bun:test";
import type {
  Dial,
  DialTicket,
  Grant,
  Principal,
  PrincipalCredentials,
  Share,
  ShareGrant,
  TokenGrant,
} from "@manifold/protocol";
import { accessHandlers } from "../src/server.ts";

/** Real admission and credential behavior are exercised in access-door.test.ts.
 * These cases retain only the handler-owned resource guard and combined-inventory refusal.
 */

interface Call {
  readonly kind:
    | "create"
    | "mint"
    | "revoke"
    | "listCredentials"
    | "mintShare"
    | "revokeShare"
    | "listShares"
    | "grant"
    | "revokeGrant"
    | "listGrants"
    | "dial"
    | "open"
    | "listDials";
  readonly payload: unknown;
}

type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface Recorder {
  readonly ctx: Parameters<typeof accessHandlers.mint>[0];
  readonly calls: Call[];
}

const principal: Principal = { id: "p-1", kind: "human", name: "delegate", color: "#2563eb" };
const grant: TokenGrant = {
  token: "raw-secret",
  principal,
  caps: ["containers:read"],
  containerId: null,
};

/** One principal and its one live credential, as the credential list hands it back. */
const credentials: PrincipalCredentials = {
  principal,
  createdAt: 1_700_000_000_000,
  sessions: [
    {
      id: "token-1",
      createdAt: 1_700_000_000_000,
      caps: ["containers:read"],
      expiresAt: 1_700_000_000_000 + 14 * 24 * 60 * 60 * 1000,
    },
  ],
};

const share: Share = {
  id: "share-1",
  ref: { kind: "container", containerId: "container-7" },
  caps: ["containers:read"],
  origin: "https://guest.example",
  createdAt: 1_700_000_000_000,
  createdBy: "p-0",
  revokedAt: null,
  tickets: 1,
};
const shareGrant: ShareGrant = { share, token: "raw-share-secret" };
const dial: Dial = {
  id: "dial-1",
  origin: "https://host.example",
  ref: { kind: "container", containerId: "remote-3" },
  caps: ["containers:read"],
  title: "Their canvas",
  status: "live",
  dialedAt: 1_700_000_000_000,
};
const ticket: DialTicket = {
  origin: "https://host.example",
  ref: { kind: "container", containerId: "remote-3" },
  caps: ["containers:read"],
  token: "ticket-secret",
};

/**
 * One authority row, as the mechanism hands it back. Named for what it IS rather than `grant`,
 * which this file already spends on a `TokenGrant`: a token grant is a CREDENTIAL and this is a
 * ROW, and letting one identifier mean both in one file is how the two concepts get confused.
 */
const authorityRow: Grant = {
  id: "grant-1",
  principal: { kind: "principal", id: "p-1" },
  node: "manifold://container/container-7",
  caps: ["containers:write"],
  effect: "allow",
  reach: "subtree",
  createdBy: "p-0",
  createdAt: 1_700_000_000_000,
};

/** A mechanism under the test's control: it either issues, or refuses with a code and words. */
function recorder(options: {
  create?: Answer<TokenGrant>;
  mint?: Answer<TokenGrant>;
  revoke?: Answer<number>;
  listCredentials?: Answer<readonly PrincipalCredentials[]>;
  mintShare?: Answer<ShareGrant>;
  revokeShare?: Answer<number>;
  listShares?: Answer<readonly Share[]>;
  dial?: Answer<Dial>;
  open?: Answer<DialTicket>;
  listDials?: Answer<readonly Dial[]>;
  grant?: Answer<Grant>;
  revokeGrant?: Answer<number>;
  listGrants?: Answer<readonly Grant[]>;
}): Recorder {
  const calls: Call[] = [];
  const answer = <T>(given: Answer<T> | undefined, fallback: T): Answer<T> =>
    given ?? { ok: true, value: fallback };
  const unused = (): never => {
    throw new Error("unused Agent lifecycle fixture");
  };
  return {
    calls,
    ctx: {
      identity: {
        createPrincipal: (input) => {
          calls.push({ kind: "create", payload: input });
          return answer(options.create, grant);
        },
        registerAgent: unused,
        listAgents: unused,
        getAgent: unused,
        updateAgent: unused,
        disableAgent: unused,
        enableAgent: unused,
        retireAgent: unused,
        createRun: unused,
        createChildRun: unused,
        listRuns: unused,
        inspectRun: unused,
        listHarnesses: unused,
        listHarnessSessions: unused,
        resolveHarnessSession: unused,
        launchRun: unused,
        sendRunInput: unused,
        reportRunActivity: unused,
        agentPolicyChallenge: unused,
        acknowledgeAgentPolicy: unused,
        renewAgentRun: unused,
        finishAgentRun: unused,
        reloadAgentPolicy: unused,
        mintTokenV2: unused,
        listCredentialsV2: unused,
        registerAgentV2: unused,
        getAgentV2: unused,
        listAgentsV2: unused,
        updateAgentV2: unused,
        disableAgentV2: unused,
        enableAgentV2: unused,
        retireAgentV2: unused,
        createRunV2: unused,
        createChildRunV2: unused,
        listRunsV2: unused,
        inspectRunV2: unused,
        reportRunActivityV2: unused,
        acknowledgeAgentPolicyV2: unused,
        renewAgentRunV2: unused,
        finishAgentRunV2: unused,
        mintToken: (input) => {
          calls.push({ kind: "mint", payload: input });
          return answer(options.mint, grant);
        },
        revokePrincipal: (principalId) => {
          calls.push({ kind: "revoke", payload: principalId });
          return answer(options.revoke, 0);
        },
        pausePrincipalAccess: unused,
        resumePrincipalAccess: unused,
        listCredentials: () => {
          calls.push({ kind: "listCredentials", payload: null });
          return answer(options.listCredentials, [credentials]);
        },
        mintShare: (input) => {
          calls.push({ kind: "mintShare", payload: input });
          return answer(options.mintShare, shareGrant);
        },
        revokeShare: (shareId) => {
          calls.push({ kind: "revokeShare", payload: shareId });
          return answer(options.revokeShare, 0);
        },
        listShares: () => {
          calls.push({ kind: "listShares", payload: null });
          return answer(options.listShares, [share]);
        },
        grant: (input) => {
          calls.push({ kind: "grant", payload: input });
          return answer(options.grant, authorityRow);
        },
        revokeGrant: (grantId) => {
          calls.push({ kind: "revokeGrant", payload: grantId });
          return answer(options.revokeGrant, 0);
        },
        listGrants: (filter) => {
          calls.push({ kind: "listGrants", payload: filter });
          return answer(options.listGrants, [authorityRow]);
        },
      },
      dials: {
        dial: async (input) => {
          calls.push({ kind: "dial", payload: input });
          return answer(options.dial, dial);
        },
        open: async (dialId) => {
          calls.push({ kind: "open", payload: dialId });
          return answer(options.open, ticket);
        },
        list: () => {
          calls.push({ kind: "listDials", payload: null });
          return answer(options.listDials, [dial]);
        },
      },
    },
  };
}

function refusal(outcome: unknown): string {
  if (outcome === null || typeof outcome !== "object" || !("refused" in outcome)) {
    throw new Error("expected a refusal");
  }
  const reason = Reflect.get(outcome, "refused");
  if (typeof reason !== "string") throw new Error("a refusal must carry a string");
  return reason;
}

describe("core.access share doors (ADR 0014)", () => {
  const mintArgs = {
    node: { kind: "container" as const, containerId: "container-7" },
    caps: ["containers:read" as const],
    origin: "https://guest.example",
  };

  test("only a container can be shared, and that rung is the DOOR's own", async () => {
    /*
      The one rule these handlers own rather than relay. A share is a token bound to a node,
      and the grant a token expresses today is a CONTAINER scope — so a share naming a terminal
      or an element would be a grant the mechanism beneath cannot express, and answering
      "minted" would misdescribe what was granted. The refusal happens before the mechanism is
      touched, because there is nothing for it to decide.
    */
    const host = recorder({});

    for (const node of [
      { kind: "terminal" as const, terminalId: "t1" },
      { kind: "element" as const, containerId: "c1", elementId: "e1" },
      { kind: "principal" as const, principalId: "p1" },
    ]) {
      expect(refusal(await accessHandlers.mintShare(host.ctx, { ...mintArgs, node }))).toBe(
        "only a container can be shared",
      );
    }
    expect(host.calls).toEqual([]);
  });

  test("a half-failed inventory refuses whole rather than answering half true", async () => {
    /*
      "Here are your dials, and something went wrong with your shares" is a shape no caller can
      act on — and a partially-true answer about who holds authority over this workspace is
      worse than no answer.
    */
    const host = recorder({
      listShares: { ok: false, code: "forbidden", message: "root capability required" },
    });

    expect(refusal(await accessHandlers.listShares(host.ctx))).toBe("root capability required");
    expect(host.calls.map((call) => call.kind)).toEqual(["listShares"]);
  });
});
