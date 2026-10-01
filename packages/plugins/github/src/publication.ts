import { createHash, randomBytes } from "node:crypto";
import type { GuestCtx, GuestDatabase, GuestLifecycle } from "@manifold/plugin-kit/server";
import { canonicalJobJson, hasCap, type AskableCap, type ServiceInput } from "@manifold/protocol";
import { z } from "zod";
import {
  CAPS,
  ConnectionMetadataSchema,
  ConnectionSchema,
  ConfigureConnectionInputSchema,
  DigestSchema,
  DOORS,
  LIMITS,
  PLUGIN_ID,
  PrepareIssuePublicationInputSchema,
  PublicationSchema,
  PublishIssueInputSchema,
  ReadConnectionsInputSchema,
  ReadPublicationInputSchema,
  ReceiptSchema,
  ReconcilePublicationInputSchema,
  bytes,
  type Connection,
  type ConnectionMetadata,
  type Publication,
  type Receipt,
} from "./contract.ts";
import {
  GITHUB_ORIGIN,
  IssueEvidenceSchema,
  NATIVE_OPS,
  issueReceipt,
  publicationDigest,
  validateGithubPolicy,
  verifyGithubIdentity,
} from "./policy.ts";

const InstallationSchema = z.strictObject({
  sha256: DigestSchema,
  installedAt: z.number().int().nonnegative(),
});
const PreparedSchema = PublicationSchema.pick({
  operationId: true,
  reviewedDigest: true,
  connection: true,
  publicTitle: true,
  publicBody: true,
  marker: true,
}).extend({ installation: InstallationSchema, inputDigest: DigestSchema });
type Installation = z.infer<typeof InstallationSchema>;
type Prepared = z.infer<typeof PreparedSchema>;
type Row = {
  operation_id: string;
  requester: string;
  caller_origin: string;
  consumer_ref: string;
  connection_id: string;
  connection_revision: string;
  record: string;
  retained_bytes: number;
  phase: Publication["state"];
  receipt: string | null;
  candidate: string | null;
  reconciliation: Publication["reconciliation"];
};
type Call = {
  database: GuestDatabase;
  installation: Installation;
  lease: string;
  requester: string;
};

class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}

async function installation(ctx: GuestCtx, cap: AskableCap): Promise<Installation> {
  if (!(await ctx.auth.allows(cap))) throw new Refusal("authority_unavailable");
  const row = (await ctx.host.roster()).find((entry) => entry.manifest.id === PLUGIN_ID);
  if (
    !row?.enabled ||
    row.held ||
    row.refusal ||
    (row.lifecycle && row.lifecycle !== "ok") ||
    !row.install ||
    row.install.refusal ||
    !hasCap(row.install.grantedCaps, cap)
  )
    throw new Refusal("installation_unavailable");
  return InstallationSchema.parse({
    sha256: row.install.sha256,
    installedAt: row.install.installedAt,
  });
}

async function withCall<I, O>(
  ctx: GuestCtx,
  schema: z.ZodType<I>,
  raw: unknown,
  cap: AskableCap,
  run: (input: I, call: Call) => Promise<O>,
): Promise<O | { refused: string }> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { refused: "invalid_input" };
  let call: Call | undefined;
  try {
    const pin = await installation(ctx, cap);
    const database = ctx.database;
    if (!database) throw new Refusal("database_unavailable");
    const lease = randomBytes(16).toString("hex");
    const admitted = await database.run(
      "INSERT INTO calls(token) SELECT ? WHERE (SELECT count(*) FROM calls) < ?",
      [lease, LIMITS.activeCalls],
    );
    if (admitted.changes !== 1) throw new Refusal("busy");
    call = {
      database,
      installation: pin,
      lease,
      requester: canonicalJobJson({
        kind: ctx.principal.kind,
        id: ctx.principal.id,
        origin: ctx.principal.origin ?? null,
      }),
    };
    const result = await run(parsed.data, call);
    if (result !== null && typeof result === "object" && "connection" in result) {
      const connection = ConnectionSchema.parse(result.connection);
      await check(ctx, cap, call, connection, NATIVE_OPS.account);
      await check(ctx, cap, call, connection, NATIVE_OPS.repository);
      if (cap === CAPS.publish) await check(ctx, cap, call, connection, NATIVE_OPS.create);
    } else {
      await check(ctx, cap, call);
    }
    return result;
  } catch (error) {
    return { refused: error instanceof Refusal ? error.code : "provider_unavailable" };
  } finally {
    if (call) {
      try {
        await call.database.run("DELETE FROM calls WHERE token = ?", [call.lease]);
      } catch {
        // A revoked dispatch cannot clean its slot. Re-enable clears slots and fences effects.
      }
    }
  }
}

/** Every await continuation re-proves authority and the installed artifact, never a cached grant. */
async function check(
  ctx: GuestCtx,
  cap: AskableCap,
  call: Call,
  connection?: ConnectionMetadata | Connection,
  operationId?: string,
): Promise<void> {
  const pin = await installation(ctx, cap);
  if (canonicalJobJson(pin) !== canonicalJobJson(call.installation))
    throw new Refusal("stale_installation");
  if (connection && "connectionRevision" in connection) {
    const { connectionRevision, ...metadata } = connection;
    if (digest({ version: 1, metadata, installation: call.installation }) !== connectionRevision) {
      throw new Refusal("stale_installation");
    }
    const rows = await call.database.query<{ revision: string }>(
      "SELECT revision FROM connections WHERE id = ?",
      [connection.connectionId],
    );
    if (rows[0]?.revision !== connection.connectionRevision) throw new Refusal("stale_connection");
  }
  if (connection && operationId) {
    const nativeCap = operationId === NATIVE_OPS.create ? "services:invoke" : "services:read";
    if (
      !(await ctx.auth.allows(nativeCap, {
        kind: "service",
        machineId: connection.machineId,
        serviceId: connection.serviceId,
        operationId,
      }))
    )
      throw new Refusal("authority_unavailable");
    const description = await ctx.services.describe({ machineId: connection.machineId });
    const service = description.services.find((entry) => entry.serviceId === connection.serviceId);
    const operation = service?.operations.find((entry) => entry.operationId === operationId);
    if (
      !description.connected ||
      description.machineId !== connection.machineId ||
      service?.revision !== connection.serviceRevision ||
      service.policySha256 !== connection.policySha256 ||
      !operation?.ready ||
      (nativeCap === "services:read" ? !operation.readable : !operation.invocable)
    )
      throw new Refusal("native_unavailable");
    // describe is a discovery projection, not the grant for this mode.
    if (
      !(await ctx.auth.allows(nativeCap, {
        kind: "service",
        machineId: connection.machineId,
        serviceId: connection.serviceId,
        operationId,
      }))
    )
      throw new Refusal("authority_unavailable");
  }
  const leases = await call.database.query<{ token: string }>(
    "SELECT token FROM calls WHERE token = ?",
    [call.lease],
  );
  if (leases.length !== 1) throw new Refusal("recovery_fence");
  if (!(await ctx.auth.allows(cap))) throw new Refusal("authority_unavailable");
}

async function nativeRead(
  ctx: GuestCtx,
  cap: AskableCap,
  call: Call,
  connection: ConnectionMetadata | Connection,
  operationId: string,
  input: ServiceInput = {},
): Promise<unknown> {
  await check(ctx, cap, call, connection, operationId);
  const reply = await ctx.services.read({
    machineId: connection.machineId,
    serviceId: connection.serviceId,
    revision: connection.serviceRevision,
    policySha256: connection.policySha256,
    operationId,
    input,
  });
  await check(ctx, cap, call, connection, operationId);
  if (!reply.ok) throw new Refusal("native_unavailable");
  return reply.result;
}

async function preflight(
  ctx: GuestCtx,
  cap: AskableCap,
  call: Call,
  connection: ConnectionMetadata | Connection,
): Promise<void> {
  const account = await nativeRead(ctx, cap, call, connection, NATIVE_OPS.account);
  const repository = await nativeRead(ctx, cap, call, connection, NATIVE_OPS.repository);
  if (!verifyGithubIdentity(account, repository, connection))
    throw new Refusal("account_or_destination_unavailable");
  await check(ctx, cap, call, connection);
}

async function connectionFor(call: Call, connectionId: string): Promise<Connection> {
  const rows = await call.database.query<{ record: string }>(
    "SELECT record FROM connections WHERE id = ?",
    [connectionId],
  );
  if (!rows[0]) throw new Refusal("connection_unavailable");
  return ConnectionSchema.parse(JSON.parse(rows[0].record));
}

async function operationFor(call: Call, operationId: string): Promise<Row> {
  const rows = await call.database.query<Row>(
    "SELECT * FROM publications WHERE operation_id = ? AND requester = ?",
    [operationId, call.requester],
  );
  if (!rows[0]) throw new Refusal("publication_unavailable");
  return rows[0];
}

function projection(row: Row): Publication {
  const prepared = PreparedSchema.parse(JSON.parse(row.record));
  return PublicationSchema.parse({
    version: 1,
    operationId: prepared.operationId,
    state: row.phase,
    reviewedDigest: prepared.reviewedDigest,
    connection: prepared.connection,
    publicTitle: prepared.publicTitle,
    publicBody: prepared.publicBody,
    marker: prepared.marker,
    receipt: row.receipt === null ? null : ReceiptSchema.parse(JSON.parse(row.receipt)),
    candidateIssueNumber:
      row.candidate === null ? null : ReceiptSchema.parse(JSON.parse(row.candidate)).issueNumber,
    reconciliation: row.reconciliation,
  });
}

async function preparedFor(
  ctx: GuestCtx,
  cap: AskableCap,
  call: Call,
  row: Row,
): Promise<Prepared> {
  const prepared = PreparedSchema.parse(JSON.parse(row.record));
  if (canonicalJobJson(prepared.installation) !== canonicalJobJson(call.installation))
    throw new Refusal("stale_installation");
  if (publicationDigest(prepared) !== prepared.reviewedDigest)
    throw new Refusal("publication_unavailable");
  await preflight(ctx, cap, call, prepared.connection);
  return prepared;
}

/** One atomic receipt commit. No successful write is followed by a second create attempt. */
async function confirm(call: Call, row: Row, receipt: Receipt): Promise<Row> {
  await call.database.run(
    `UPDATE publications SET phase = 'published', receipt = ?, candidate = NULL, reconciliation = NULL
     WHERE operation_id = ? AND requester = ? AND phase = ? AND EXISTS (SELECT 1 FROM calls WHERE token = ?)
     AND EXISTS (SELECT 1 FROM connections WHERE id = publications.connection_id AND revision = publications.connection_revision)`,
    [JSON.stringify(receipt), row.operation_id, call.requester, row.phase, call.lease],
  );
  return operationFor(call, row.operation_id);
}

async function unknown(
  call: Call,
  row: Row,
  reason: Publication["reconciliation"],
  candidate: Receipt | null = null,
): Promise<Row> {
  await call.database.run(
    `UPDATE publications SET phase = 'outcome_unknown', reconciliation = ?, candidate = COALESCE(?, candidate)
     WHERE operation_id = ? AND requester = ? AND phase != 'published'`,
    [
      reason,
      candidate === null ? null : JSON.stringify(candidate),
      row.operation_id,
      call.requester,
    ],
  );
  return operationFor(call, row.operation_id);
}

export const handlers = {
  async [DOORS.configureConnection](ctx: GuestCtx, raw: unknown) {
    return withCall(
      ctx,
      ConfigureConnectionInputSchema,
      raw,
      CAPS.configure,
      async (input, call) => {
        if (
          !ctx.auth.isRoot ||
          !(await ctx.auth.allows("services:configure", {
            kind: "machine",
            machineId: input.machineId,
          }))
        ) {
          throw new Refusal("root_configuration_required");
        }
        const { expectedRevision, ...metadata } = input;
        const configuration = await ctx.services.readConfiguration({ machineId: input.machineId });
        const policy = configuration.configuration.policies.find(
          (entry) => entry.serviceId === input.serviceId,
        );
        if (!configuration.connected || !policy || !validateGithubPolicy(policy, metadata))
          throw new Refusal("unsupported_native_policy");
        if (
          !configuration.credentialReferences.some(
            (entry) =>
              entry.ref === policy.credential?.ref &&
              entry.available &&
              entry.origins.includes(GITHUB_ORIGIN),
          )
        )
          throw new Refusal("credential_unavailable");
        await preflight(ctx, CAPS.configure, call, metadata);
        const connection: Connection = {
          ...ConnectionMetadataSchema.parse(metadata),
          connectionRevision: digest({ version: 1, metadata, installation: call.installation }),
        };
        await check(ctx, CAPS.configure, call);
        if (
          !ctx.auth.isRoot ||
          !(await ctx.auth.allows("services:configure", {
            kind: "machine",
            machineId: input.machineId,
          }))
        ) {
          throw new Refusal("root_configuration_required");
        }
        const prior = await call.database.query<{ revision: string }>(
          "SELECT revision FROM connections WHERE id = ?",
          [input.connectionId],
        );
        if (prior[0]?.revision === connection.connectionRevision)
          return { version: 1 as const, connection };
        if ((prior[0]?.revision ?? null) !== expectedRevision)
          throw new Refusal("connection_conflict");
        if (!ctx.auth.isRoot) throw new Refusal("root_configuration_required");
        const saved = await call.database.run(
          `INSERT INTO connections(id, revision, record)
         SELECT ?, ?, ? WHERE ((SELECT count(*) FROM connections) < ? OR EXISTS (SELECT 1 FROM connections WHERE id = ?))
         AND EXISTS (SELECT 1 FROM calls WHERE token = ?)
         AND NOT EXISTS (SELECT 1 FROM publications WHERE connection_id = ? AND phase = 'dispatching')
         ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, record = excluded.record WHERE connections.revision = ?`,
          [
            connection.connectionId,
            connection.connectionRevision,
            JSON.stringify(connection),
            LIMITS.connections,
            connection.connectionId,
            call.lease,
            connection.connectionId,
            expectedRevision,
          ],
        );
        if (saved.changes !== 1) throw new Refusal("connection_conflict_or_limit");
        await check(ctx, CAPS.configure, call, connection);
        return { version: 1 as const, connection };
      },
    );
  },

  async [DOORS.readConnections](ctx: GuestCtx, raw: unknown) {
    return withCall(ctx, ReadConnectionsInputSchema, raw, CAPS.read, async (_input, call) => {
      const rows = await call.database.query<{ record: string }>(
        "SELECT record FROM connections ORDER BY id",
      );
      const connections: Connection[] = [];
      for (const row of rows) {
        const connection = ConnectionSchema.parse(JSON.parse(row.record));
        try {
          await preflight(ctx, CAPS.read, call, connection);
          connections.push(connection);
        } catch (error) {
          // Hidden or currently unavailable destinations do not become a connection directory.
          if (!(error instanceof Refusal)) throw error;
        }
      }
      for (const connection of connections) {
        await check(ctx, CAPS.read, call, connection, NATIVE_OPS.account);
        await check(ctx, CAPS.read, call, connection, NATIVE_OPS.repository);
      }
      return { version: 1 as const, connections };
    });
  },

  async [DOORS.prepareIssuePublication](ctx: GuestCtx, raw: unknown) {
    return withCall(
      ctx,
      PrepareIssuePublicationInputSchema,
      raw,
      CAPS.prepare,
      async (input, call) => {
        // Reading an unsupported callerPlugin throws; missing attribution is never treated as direct.
        const callerOrigin = canonicalJobJson(ctx.callerPlugin);
        if (ctx.callerPlugin !== null && typeof ctx.callerPlugin !== "string")
          throw new Refusal("caller_attribution_unavailable");
        const connection = await connectionFor(call, input.connectionId);
        await preflight(ctx, CAPS.prepare, call, connection);
        const inputDigest = digest({
          publicTitle: input.publicTitle,
          publicBody: input.publicBody,
          connection,
          installation: call.installation,
        });
        const key = [call.requester, callerOrigin, input.consumerRef];
        const existing = await call.database.query<Row>(
          "SELECT * FROM publications WHERE requester = ? AND caller_origin = ? AND consumer_ref = ?",
          key,
        );
        if (existing[0]) {
          const prepared = await preparedFor(ctx, CAPS.prepare, call, existing[0]);
          if (prepared.inputDigest !== inputDigest) throw new Refusal("publication_conflict");
          return projection(await operationFor(call, existing[0].operation_id));
        }
        const marker = `<!-- manifold-github:${randomBytes(24).toString("hex")} -->`;
        const publicBody = `${input.publicBody}\n\n${marker}`;
        const target = `/repos/${connection.owner}/${connection.repository}/issues`;
        if (
          bytes(publicBody) > LIMITS.bodyBytes ||
          bytes(target) + bytes(JSON.stringify({ title: input.publicTitle, body: publicBody })) >
            65536
        ) {
          throw new Refusal("public_payload_limit");
        }
        const draft = {
          operationId: randomBytes(16).toString("hex"),
          connection,
          publicTitle: input.publicTitle,
          publicBody,
          marker,
        };
        const prepared: Prepared = {
          ...draft,
          reviewedDigest: publicationDigest(draft),
          installation: call.installation,
          inputDigest,
        };
        const record = JSON.stringify(prepared);
        // Reserve room for the bounded receipt and recovery candidate before any external effect.
        const retainedBytes =
          bytes(record) +
          bytes(call.requester) +
          bytes(callerOrigin) +
          bytes(input.consumerRef) +
          4096;
        await check(ctx, CAPS.prepare, call, connection);
        await call.database.run(
          `INSERT INTO publications(operation_id, requester, caller_origin, consumer_ref, connection_id, connection_revision,
          record, retained_bytes, phase, receipt, candidate, reconciliation)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, NULL, NULL
         WHERE (SELECT count(*) FROM publications) < ? AND (SELECT COALESCE(sum(retained_bytes), 0) FROM publications) + ? <= ?
         AND EXISTS (SELECT 1 FROM connections WHERE id = ? AND revision = ?)
         AND EXISTS (SELECT 1 FROM calls WHERE token = ?)
         ON CONFLICT(requester, caller_origin, consumer_ref) DO NOTHING`,
          [
            prepared.operationId,
            ...key,
            connection.connectionId,
            connection.connectionRevision,
            record,
            retainedBytes,
            LIMITS.operations,
            retainedBytes,
            LIMITS.retainedBytes,
            connection.connectionId,
            connection.connectionRevision,
            call.lease,
          ],
        );
        const rows = await call.database.query<Row>(
          "SELECT * FROM publications WHERE requester = ? AND caller_origin = ? AND consumer_ref = ?",
          key,
        );
        if (!rows[0]) throw new Refusal("publication_limit_or_stale");
        const winner = await preparedFor(ctx, CAPS.prepare, call, rows[0]);
        if (winner.inputDigest !== inputDigest) throw new Refusal("publication_conflict");
        return projection(await operationFor(call, rows[0].operation_id));
      },
    );
  },

  async [DOORS.readPublication](ctx: GuestCtx, raw: unknown) {
    return withCall(ctx, ReadPublicationInputSchema, raw, CAPS.read, async (input, call) => {
      const row = await operationFor(call, input.operationId);
      await preparedFor(ctx, CAPS.read, call, row);
      return projection(await operationFor(call, input.operationId));
    });
  },

  async [DOORS.publishIssue](ctx: GuestCtx, raw: unknown) {
    return withCall(ctx, PublishIssueInputSchema, raw, CAPS.publish, async (input, call) => {
      let row = await operationFor(call, input.operationId);
      const prepared = await preparedFor(ctx, CAPS.publish, call, row);
      if (prepared.reviewedDigest !== input.reviewedDigest) throw new Refusal("stale_review");
      await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.account);
      await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.repository);
      await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.create);
      const claimed = await call.database.run(
        `UPDATE publications SET phase = 'dispatching' WHERE operation_id = ? AND requester = ? AND phase = 'ready'
         AND EXISTS (SELECT 1 FROM calls WHERE token = ?)
         AND EXISTS (SELECT 1 FROM connections WHERE id = publications.connection_id AND revision = publications.connection_revision)`,
        [input.operationId, call.requester, call.lease],
      );
      row = await operationFor(call, input.operationId);
      if (claimed.changes !== 1) return projection(row);
      let candidate: Receipt | null = null;
      let entered = false;
      try {
        await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.account);
        await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.repository);
        await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.create);
        row = await operationFor(call, input.operationId);
        if (row.phase !== "dispatching") return projection(row);
        // The durable CAS above is the effect fence. After this line every uncertainty is unknown.
        entered = true;
        const reply = await ctx.services.invoke({
          machineId: prepared.connection.machineId,
          serviceId: prepared.connection.serviceId,
          revision: prepared.connection.serviceRevision,
          policySha256: prepared.connection.policySha256,
          operationId: NATIVE_OPS.create,
          input: { title: prepared.publicTitle, body: prepared.publicBody },
        });
        if (reply.ok) candidate = issueReceipt(reply.result, prepared);
        await check(ctx, CAPS.publish, call, prepared.connection, NATIVE_OPS.create);
        if (candidate) {
          const committed = await confirm(call, row, candidate);
          if (committed.phase === "published") return projection(committed);
        }
        return projection(
          await unknown(
            call,
            row,
            candidate ? "receipt_uncommitted" : "response_unknown",
            candidate,
          ),
        );
      } catch (error) {
        // Even pre-invoke revocation after claiming is fenced rather than reset to ready.
        try {
          row = await unknown(
            call,
            row,
            candidate ? "receipt_uncommitted" : "response_unknown",
            candidate,
          );
        } catch {
          // The persisted dispatching fence is still nonretryable; startup marks it unknown.
          row = {
            ...row,
            phase: "outcome_unknown",
            reconciliation: candidate ? "receipt_uncommitted" : "response_unknown",
            candidate: candidate === null ? row.candidate : JSON.stringify(candidate),
          };
        }
        if (!entered || error instanceof Refusal) throw error;
        return projection(row);
      }
    });
  },

  async [DOORS.reconcilePublication](ctx: GuestCtx, raw: unknown) {
    return withCall(ctx, ReconcilePublicationInputSchema, raw, CAPS.read, async (input, call) => {
      let row = await operationFor(call, input.operationId);
      const prepared = await preparedFor(ctx, CAPS.read, call, row);
      if (row.phase === "published" || row.phase === "dispatching") return projection(row);
      // Lookup cannot race a later publish of an as-yet-ready operation.
      if (row.phase === "ready") {
        await call.database.run(
          "UPDATE publications SET phase = 'outcome_unknown', reconciliation = 'no_match' WHERE operation_id = ? AND requester = ? AND phase = 'ready'",
          [input.operationId, call.requester],
        );
        row = await operationFor(call, input.operationId);
        if (row.phase === "published" || row.phase === "dispatching") return projection(row);
      }
      if (input.issueNumber !== undefined) {
        const value = await nativeRead(
          ctx,
          CAPS.read,
          call,
          prepared.connection,
          NATIVE_OPS.issue,
          { issueNumber: String(input.issueNumber) },
        );
        const receipt = issueReceipt(value, prepared);
        if (!receipt || receipt.issueNumber !== input.issueNumber)
          return projection(await unknown(call, row, "conflict"));
        await check(ctx, CAPS.read, call, prepared.connection, NATIVE_OPS.issue);
        return projection(await confirm(call, row, receipt));
      }
      let candidate: Receipt | null = null;
      let exhausted = false;
      const seenNumbers = new Set<number>();
      const seenIds = new Set<number>();
      const seenNodes = new Set<string>();
      for (let page = 1; page <= LIMITS.pages; page++) {
        const value = await nativeRead(ctx, CAPS.read, call, prepared.connection, NATIVE_OPS.list, {
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: LIMITS.pageSize,
          page,
        });
        if (!Array.isArray(value) || value.length > LIMITS.pageSize)
          return projection(await unknown(call, row, "invalid_evidence"));
        for (const item of value) {
          const parsed = IssueEvidenceSchema.safeParse(item);
          if (!parsed.success) return projection(await unknown(call, row, "invalid_evidence"));
          const issue = parsed.data;
          const repositoryPath = `${prepared.connection.owner}/${prepared.connection.repository}`;
          const expectedKind = issue.pull_request ? "pull" : "issues";
          if (
            issue.repository_url !== `${GITHUB_ORIGIN}/repos/${repositoryPath}` ||
            issue.html_url !==
              `https://github.com/${repositoryPath}/${expectedKind}/${issue.number}` ||
            (issue.pull_request &&
              issue.pull_request.url !==
                `${GITHUB_ORIGIN}/repos/${repositoryPath}/pulls/${issue.number}`)
          )
            return projection(await unknown(call, row, "invalid_evidence"));
          if (
            seenNumbers.has(issue.number) ||
            seenIds.has(issue.id) ||
            seenNodes.has(issue.node_id)
          ) {
            return projection(await unknown(call, row, "incomplete"));
          }
          seenNumbers.add(issue.number);
          seenIds.add(issue.id);
          seenNodes.add(issue.node_id);
          if (!issue.body?.includes(prepared.marker)) continue;
          const receipt = issueReceipt(issue, prepared);
          if (!receipt || candidate) return projection(await unknown(call, row, "conflict"));
          candidate = receipt;
        }
        if (value.length < LIMITS.pageSize) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted) return projection(await unknown(call, row, "incomplete"));
      if (!candidate) return projection(await unknown(call, row, "no_match"));
      await check(ctx, CAPS.read, call, prepared.connection, NATIVE_OPS.list);
      return projection(await confirm(call, row, candidate));
    });
  },
};

export const lifecycle: GuestLifecycle = {
  async onEnable(ctx) {
    if (!ctx.database) throw new Error("database_unavailable");
    await ctx.database.batch([
      {
        sql: "CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL)",
      },
      { sql: "CREATE TABLE IF NOT EXISTS calls(token TEXT PRIMARY KEY)" },
      {
        sql: `CREATE TABLE IF NOT EXISTS publications(
        operation_id TEXT PRIMARY KEY, requester TEXT NOT NULL, caller_origin TEXT NOT NULL, consumer_ref TEXT NOT NULL,
        connection_id TEXT NOT NULL, connection_revision TEXT NOT NULL, record TEXT NOT NULL, retained_bytes INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('ready','dispatching','published','outcome_unknown')),
        receipt TEXT, candidate TEXT, reconciliation TEXT, UNIQUE(requester, caller_origin, consumer_ref))`,
      },
      {
        sql: "UPDATE publications SET phase = 'outcome_unknown', reconciliation = 'recovery_fence' WHERE phase IN ('ready', 'dispatching')",
      },
      { sql: "DELETE FROM calls" },
    ]);
  },
  async onDisable(ctx) {
    if (!ctx.database) throw new Error("database_unavailable");
    await ctx.database.batch([
      {
        sql: "UPDATE publications SET phase = 'outcome_unknown', reconciliation = 'recovery_fence' WHERE phase IN ('ready', 'dispatching')",
      },
      { sql: "DELETE FROM calls" },
    ]);
  },
};
