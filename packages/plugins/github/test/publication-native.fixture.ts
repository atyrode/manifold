import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { canonicalJobJson, type ServicePolicy } from "@manifold/protocol";
import type { JobServiceRunner } from "../../../agent/src/job-services.ts";
import type { ConnectionMetadata, Publication } from "../src/contract.ts";
import { githubServicePolicy } from "../src/policy.ts";

// Snapshot before any test-module replacement; mock.restore() does not restore modules.
const actualHttps = { ...https };
let receiverActive = false;

// All values belong to this disposable fixture. No environment/CLI credential is read.
export const SYNTHETIC_CREDENTIAL = "github-publication-synthetic-owner-credential";
export const PRIVATE_CANARY = "fixture-private-evidence-not-reviewed";
export const RESPONSE_CANARY = "fixture-native-response-private-sidecar";
export const CREDENTIAL_REF = "github-publication-fixture-key";
export const REPOSITORY_PATH = "/repos/fixture-owner/fixture-repo";
export const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");

export function nativePolicy(machineId = "fixture-machine", serviceId = "fixture-github") {
  const metadata: ConnectionMetadata = {
    connectionId: "fixture-connection",
    machineId,
    serviceId,
    serviceRevision: "fixture-r1",
    policySha256: "0".repeat(64),
    owner: "fixture-owner",
    repository: "fixture-repo",
    ownerNodeId: "O_fixture_owner",
    repositoryNodeId: "R_fixture_repo",
    accountLogin: "fixture-user",
    accountNodeId: "U_fixture_user",
    credentialMode: "owner-user-token",
  };
  const policy = githubServicePolicy(metadata, CREDENTIAL_REF);
  metadata.policySha256 = hash(policy);
  return { metadata, policy };
}

export interface FixtureIssue {
  id: number;
  node_id: string;
  number: number;
  html_url: string;
  repository_url: string;
  title: string;
  body: string;
  user: { id: number; node_id: string; login: string; type: string };
}

export function issueEvidence(
  publication: Pick<Publication, "publicTitle" | "publicBody">,
  number = 1,
): FixtureIssue {
  return {
    id: 10_000 + number,
    node_id: `I_fixture_${number}`,
    number,
    html_url: `https://github.com/fixture-owner/fixture-repo/issues/${number}`,
    repository_url: `https://api.github.com${REPOSITORY_PATH}`,
    title: publication.publicTitle,
    body: publication.publicBody,
    user: { id: 22, node_id: "U_fixture_user", login: "fixture-user", type: "User" },
  };
}

export interface FixtureBarrier {
  entered: Promise<void>;
  release(): void;
  wait(): Promise<void>;
}

export function barrier(): FixtureBarrier {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

export interface ReceiverRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Real sockets and acceptance state, not service-reply mocks. HTTPS is intercepted only in
 * this test process, AFTER asserting the unmodified production URL, headers and method.
 * Unexpected destinations never fall through to real network access. Run this fixture alone;
 * the global builtin interception intentionally fails on unrelated HTTPS traffic. */
export async function githubReceiver() {
  assert.equal(receiverActive, false, "publication receivers must run serially");
  const requests: ReceiverRequest[] = [];
  const accepted: FixtureIssue[] = [];
  const failures: unknown[] = [];
  const state = {
    account: {
      id: 22,
      node_id: "U_fixture_user",
      login: "fixture-user",
      type: "User",
      html_url: "https://github.com/fixture-user",
    },
    repository: {
      id: 33,
      node_id: "R_fixture_repo",
      name: "fixture-repo",
      full_name: "fixture-owner/fixture-repo",
      html_url: "https://github.com/fixture-owner/fixture-repo",
      owner: { id: 11, node_id: "O_fixture_owner", login: "fixture-owner", type: "Organization" },
      private: false,
      visibility: "public",
      archived: false,
      has_issues: true,
    },
    create: "reply" as "reply" | "drop" | "hold",
    createGate: barrier(),
    readGate: null as FixtureBarrier | null,
    list: null as ((page: number) => unknown) | null,
    specific: null as ((number: number) => unknown) | null,
    createResponse: null as ((issue: FixtureIssue) => unknown) | null,
  };
  const reply = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    assert.equal(request.headers.authorization, `Bearer ${SYNTHETIC_CREDENTIAL}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = text === "" ? null : JSON.parse(text);
    const url = new URL(request.url!, "http://receiver.invalid");
    requests.push({ method: request.method!, path: request.url!, body });
    if (request.method === "POST") {
      assert.equal(url.pathname, `${REPOSITORY_PATH}/issues`);
      assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
      assert.deepEqual(Object.keys(body).sort(), ["body", "title"]);
      const payload = body as { title: string; body: string };
      assert.equal(typeof payload.title, "string");
      assert.equal(typeof payload.body, "string");
      const issue = issueEvidence(
        { publicTitle: payload.title, publicBody: payload.body },
        accepted.length + 1,
      );
      // The receiver commits BEFORE the response is lost or delayed.
      accepted.push(issue);
      if (state.create === "hold") await state.createGate.wait();
      if (state.create === "drop") {
        request.socket.destroy();
        return;
      }
      reply(
        response,
        state.createResponse?.(issue) ?? {
          ...issue,
          credential: SYNTHETIC_CREDENTIAL,
          private_context: RESPONSE_CANARY,
        },
      );
      return;
    }
    if (state.readGate) await state.readGate.wait();
    if (url.pathname === "/user") {
      reply(response, { ...state.account, credential: SYNTHETIC_CREDENTIAL });
    } else if (url.pathname === REPOSITORY_PATH) {
      reply(response, { ...state.repository, private_context: RESPONSE_CANARY });
    } else if (url.pathname === `${REPOSITORY_PATH}/issues`) {
      const page = Number(url.searchParams.get("page"));
      reply(response, state.list ? state.list(page) : accepted.slice((page - 1) * 2, page * 2));
    } else {
      const number = Number(url.pathname.split("/").at(-1));
      const issue = state.specific
        ? state.specific(number)
        : accepted.find((item) => item.number === number);
      if (issue === undefined) {
        response.writeHead(404);
        response.end();
      } else reply(response, issue);
    }
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      failures.push(error);
      request.socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const originalTlsConnection = actualHttps.Agent.prototype.createConnection;
  // Fail closed even if this runtime does not refresh an already-imported builtin binding.
  // agent:false still constructs an HTTPS Agent; no TLS socket may leave this test process.
  actualHttps.Agent.prototype.createConnection = () => {
    const error = new Error("unintercepted HTTPS connection refused by publication fixture");
    failures.push(error);
    throw error;
  };
  // Native transport's overload is URL + options + response callback. Reject all others.
  const intercepted = (
    url: URL | string | RequestOptions,
    options?: RequestOptions | ((res: IncomingMessage) => void),
    callback?: (res: IncomingMessage) => void,
  ) => {
    try {
      assert.ok(url instanceof URL);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert.equal(url.hash, "");
      assert.ok(options && typeof options === "object");
      const method = options.method ?? "GET";
      assert.ok(method === "GET" || method === "POST");
      if (method === "POST") {
        assert.equal(url.pathname, `${REPOSITORY_PATH}/issues`);
        assert.equal(url.search, "");
      } else if (url.pathname === `${REPOSITORY_PATH}/issues`) {
        assert.deepEqual([...url.searchParams.keys()].sort(), [
          "direction",
          "page",
          "per_page",
          "sort",
          "state",
        ]);
        assert.equal(url.searchParams.get("state"), "all");
        assert.equal(url.searchParams.get("sort"), "created");
        assert.equal(url.searchParams.get("direction"), "desc");
        assert.equal(url.searchParams.get("per_page"), "2");
        assert.match(url.searchParams.get("page")!, /^(?:[1-9]|10)$/);
      } else {
        assert.ok(
          url.pathname === "/user" ||
            url.pathname === REPOSITORY_PATH ||
            /^\/repos\/fixture-owner\/fixture-repo\/issues\/[1-9][0-9]*$/.test(url.pathname),
        );
        assert.equal(url.search, "");
      }
      const headers = new Headers(options.headers as Record<string, string>);
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(headers.get("x-github-api-version"), "2026-03-10");
      assert.equal(headers.get("authorization"), `Bearer ${SYNTHETIC_CREDENTIAL}`);
      assert.ok(headers.get("user-agent"));
      return httpRequest(
        new URL(url.pathname + url.search, `http://127.0.0.1:${address.port}`),
        options,
        callback,
      );
    } catch (error) {
      failures.push(error);
      throw error;
    }
  };
  const mockedHttps = { ...actualHttps, request: intercepted as typeof https.request };
  mock.module("node:https", () => ({ ...mockedHttps, default: mockedHttps }));
  receiverActive = true;
  return {
    state,
    requests,
    accepted,
    async close() {
      state.createGate.release();
      state.readGate?.release();
      mock.module("node:https", () => ({ ...actualHttps, default: actualHttps }));
      actualHttps.Agent.prototype.createConnection = originalTlsConnection;
      receiverActive = false;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      assert.deepEqual(failures, [], "receiver or fixed-production-URL interception failed");
    },
  };
}

export async function nativeRunner(
  policy: ServicePolicy,
  credentialAvailable: () => boolean = () => true,
): Promise<JobServiceRunner> {
  assert.ok(
    receiverActive,
    "install the fail-closed HTTP receiver before loading native transport",
  );
  // Module-loading boundary under test: a static import would precede the fail-closed mock.
  const { createJobServiceRunner } = await import("../../../agent/src/job-services.ts");
  return createJobServiceRunner({
    policies: [policy],
    resolveCredential: async (ref) => {
      assert.equal(ref, CREDENTIAL_REF);
      if (!credentialAvailable()) throw new Error("fixture credential is absent");
      return SYNTHETIC_CREDENTIAL;
    },
  });
}
