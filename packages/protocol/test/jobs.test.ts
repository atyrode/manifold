import { expect, test } from "bun:test";
import {
  canonicalJobJson,
  MachineArtifactSchema,
  MachineLocationSchema,
  MachineOperationSchema,
  JobCommandSchema,
  JobRequestSchema,
  JobLimitsSchema,
  MachineHalfSchema,
  JobDescriptionSchema,
  JobOutputBindingSchema,
  JOB_OWNER_PROTOCOL_VERSION,
  jobOwnerMachine,
  jobOwnerOperationRefusal,
  jobOwnerRequestRefusal,
  jobLimits,
  jobOwnerInstallRestoresProjection,
  jobOwnerMachine,
  jobOwnerOperationRefusal,
  ListJobRunsArgsSchema,
  ListJobRunsResultSchema,
  PublicJobRunSchema,
  PublicScheduleOccurrenceSchema,
  type JobCommand,
  type MachineHalf,
  type PublicJob,
  type PublicScheduleOccurrence,
} from "../src/jobs.ts";
import { JobDeploymentRequestSchema } from "../src/job-deployments.ts";
import { JobOwnerConfigSchema } from "../src/job-owner-config.ts";
import { JobResourceInventorySchema, jobResourceRefusal } from "../src/job-resources.ts";

test("deployment scope requires explicit operations and bounded unique destinations", () => {
  const request = {
    deploymentId: "reviewed",
    pluginId: "sample.worker",
    targets: [{ machineId: "second" }, { machineId: "first" }],
    operationIds: [],
  };
  expect(JobDeploymentRequestSchema.parse(request).targets).toEqual(request.targets);
  expect(
    JobDeploymentRequestSchema.safeParse({ ...request, operationIds: undefined }).success,
  ).toBe(false);
  expect(JobDeploymentRequestSchema.safeParse({ ...request, targets: [] }).success).toBe(false);
  expect(
    JobDeploymentRequestSchema.safeParse({
      ...request,
      targets: [request.targets[0], request.targets[0]],
    }).success,
  ).toBe(false);
  expect(
    JobDeploymentRequestSchema.safeParse({
      ...request,
      targets: Array.from({ length: 65 }, (_, index) => ({ machineId: `destination-${index}` })),
    }).success,
  ).toBe(false);
  expect(
    JobDeploymentRequestSchema.safeParse({
      ...request,
      operationIds: ["sample.worker.run", "sample.worker.run"],
    }).success,
  ).toBe(false);
});

test("job service identity is optional but incomplete references and private fields are refused", () => {
  const operationSchema = JobDescriptionSchema.shape.operations.unwrap().valueType;
  const operation = { ready: true, reason: null, resourceBindingDigest: "a".repeat(64) };
  const reference = {
    machineId: "source",
    serviceId: "sample.broker",
    revision: "configuration-revision",
    policySha256: "b".repeat(64),
  };
  expect(operationSchema.parse(operation)).toEqual(operation);
  expect(operationSchema.parse({
    ...operation,
    serviceBindings: { [reference.serviceId]: reference },
  }).serviceBindings).toEqual({ [reference.serviceId]: reference });
  for (const invalid of [
    { ...reference, revision: undefined },
    { ...reference, machineId: "" },
    { ...reference, policySha256: "not-a-digest" },
    { ...reference, credential: { ref: "private-account" } },
    { ...reference, runtime: { pluginId: "private-provider" } },
    { ...reference, serviceId: "different-service" },
  ])
    expect(operationSchema.safeParse({
      ...operation,
      serviceBindings: { [reference.serviceId]: invalid },
    }).success).toBe(false);
});

test("explicit instance pins are never sent to an accepted owner that cannot parse them", () => {
  const request = {
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
  };
  const serviceBindings = {
    "sample.broker": {
      machineId: "source",
      serviceId: "sample.broker",
      revision: "configuration-revision",
      policySha256: "b".repeat(64),
    },
  };
  expect(jobOwnerRequestRefusal(37, request)).toBeNull();
  expect(jobOwnerRequestRefusal(37, { ...request, serviceBindings })).toBe(
    "service_bindings_protocol_unsupported",
  );
  expect(jobOwnerRequestRefusal(JOB_OWNER_PROTOCOL_VERSION, { ...request, serviceBindings })).toBeNull();
  expect(JobRequestSchema.shape.serviceBindings.parse(serviceBindings)).toEqual(serviceBindings);
  expect(JobRequestSchema.shape.serviceBindings.safeParse(
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => {
      const serviceId = `sample.service-${i}`;
      return [serviceId, { ...serviceBindings["sample.broker"], serviceId }];
    })),
  ).success).toBe(false);
});

const location = { anchor: "config", components: ["vault"], revision: "r1", kind: "file" };
test("guest paths permit exact hidden files but never home-root or noncanonical paths", () => {
  expect(
    MachineLocationSchema.parse({ ...location, guestPath: "/home/job/.config/auth/vault.json" })
      .guestPath,
  ).toBe("/home/job/.config/auth/vault.json");
  for (const guestPath of [
    "/home/job",
    "/home/job/",
    "/home/job/../vault",
    "/home/job/a/../../vault",
    "/home/job/./vault",
    "/home/job//vault",
    "/home/job/a/",
    "/etc/vault",
    "/home/job/a\\b",
  ]) {
    expect(MachineLocationSchema.safeParse({ ...location, guestPath }).success).toBe(false);
  }
});

test("named resources admit hidden account directories without admitting traversal", () => {
  expect(
    MachineLocationSchema.safeParse({
      anchor: "home",
      components: [".omp", "agent", "sessions"],
      revision: "r1",
    }).success,
  ).toBe(true);
  for (const component of [".", "..", "../.omp", "/.omp", ".omp/agent", ".omp\\agent"]) {
    expect(
      MachineLocationSchema.safeParse({
        anchor: "home",
        components: [component],
        revision: "r1",
      }).success,
    ).toBe(false);
  }
});

const sessions = {
  anchor: "operator.omp-sessions",
  components: [],
  revision: "r1",
  kind: "directory",
};
test("operator anchors are an open operator-named set that a location may name whole", () => {
  expect(MachineLocationSchema.parse(sessions).anchor).toBe("operator.omp-sessions");
  expect(MachineLocationSchema.safeParse({ ...sessions, kind: undefined }).success).toBe(true);
  expect(
    MachineLocationSchema.safeParse({ ...sessions, components: ["2026", "session.jsonl"] }).success,
  ).toBe(true);
  expect(
    MachineLocationSchema.safeParse({ ...sessions, components: ["a.jsonl"], kind: "file" }).success,
  ).toBe(true);
  for (const anchor of [
    "operator.",
    "operator.A",
    "operator.-a",
    "operator.a-",
    "operator.a.b",
    "operator.a_b",
    `operator.${"a".repeat(64)}`,
    "operatorx",
    "operator",
    "sessions",
  ])
    expect(MachineLocationSchema.safeParse({ ...sessions, anchor }).success).toBe(false);
  expect(
    MachineLocationSchema.safeParse({ ...sessions, anchor: `operator.${"a".repeat(63)}` }).success,
  ).toBe(true);
  // Only an operator anchor's directory may be named whole, and never as a file.
  expect(MachineLocationSchema.safeParse({ ...sessions, kind: "file" }).success).toBe(false);
  for (const anchor of ["home", "state", "runtime"])
    expect(MachineLocationSchema.safeParse({ ...sessions, anchor }).success).toBe(false);
  // Native managed storage stays a state directory; an operator anchor cannot provision it.
  expect(
    MachineLocationSchema.safeParse({ ...sessions, components: ["store"], managed: true }).success,
  ).toBe(false);
});

const readOperation = {
  argv: [],
  input: {},
  runtimeTools: [],
  outputs: [],
  network: "none",
  stdin: false,
  limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
} as const;
const anchoredMachine = {
  artifacts: {
    "linux-x64": {
      url: "https://example.invalid/tool",
      sha256: "a".repeat(64),
      entrySha256: "b".repeat(64),
      format: "tar.gz",
      entry: ["main"],
      maxBytes: 4096,
      maxExpandedBytes: 8192,
      maxMembers: 8,
    },
  },
  locations: {
    sessions,
    scratch: { anchor: "runtime", components: ["scratch"], revision: "r1", kind: "directory" },
  },
  operations: {
    archive: {
      ...readOperation,
      locations: [
        { locationId: "sessions", access: "read" },
        { locationId: "scratch", access: "write" },
      ],
    },
    scan: { ...readOperation, locations: [{ locationId: "scratch", access: "read" }] },
  },
};
test("an operation may only read an operator anchor", () => {
  const machine = MachineHalfSchema.parse(anchoredMachine);
  expect(machine.operations.archive!.locations[0]).toEqual({
    locationId: "sessions",
    access: "read",
  });
  for (const access of ["write", "create"]) {
    const result = MachineHalfSchema.safeParse({
      ...anchoredMachine,
      operations: {
        archive: { ...readOperation, locations: [{ locationId: "sessions", access }] },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      "Operator anchors are read-only",
    ]);
  }
  // Reading an operator anchor is always pinned, even when the manifest does not ask for it.
  const inventory = {
    tools: {},
    services: {},
    anchors: { "operator.omp-sessions": "e".repeat(64), runtime: "f".repeat(64) },
    serviceDefinitions: {},
  };
  expect(machine.requiresResourceBindings).toBeUndefined();
  expect(jobResourceRefusal(machine, "archive", "linux-x64", undefined, inventory)).toBe(
    "resource_bindings_required",
  );
  expect(jobResourceRefusal(machine, "scan", "linux-x64", undefined, inventory)).toBeNull();
  const bindings = { tools: {}, services: {}, anchors: { ...inventory.anchors } };
  expect(jobResourceRefusal(machine, "archive", "linux-x64", bindings, inventory)).toBeNull();
  expect(
    jobResourceRefusal(machine, "archive", "linux-x64", bindings, {
      ...inventory,
      anchors: { ...inventory.anchors, "operator.omp-sessions": "a".repeat(64) },
    }),
  ).toBe("anchors_revision_changed");
});

test("older owners never receive an operator-anchor declaration and keep every other operation", () => {
  const machine = MachineHalfSchema.parse(anchoredMachine) as MachineHalf;
  for (const protocolVersion of [34, 35, 36, 37]) {
    expect(jobOwnerOperationRefusal(protocolVersion, machine.operations.archive!, machine)).toBe(
      "operator_anchors_protocol_unsupported",
    );
    expect(jobOwnerOperationRefusal(protocolVersion, machine.operations.scan!, machine)).toBeNull();
    const projected = jobOwnerMachine(protocolVersion, machine)!;
    expect(Object.keys(projected.operations)).toEqual(["scan"]);
    expect(Object.keys(projected.locations)).toEqual(["scratch"]);
    // What remains is exactly the declaration's own bytes, so upgrading can restore it.
    expect(canonicalJobJson(projected.operations.scan)).toBe(
      canonicalJobJson(machine.operations.scan),
    );
    expect(canonicalJobJson(projected.locations.scratch)).toBe(
      canonicalJobJson(machine.locations.scratch),
    );
    expect(canonicalJobJson({ ...projected, operations: {}, locations: {} })).toBe(
      canonicalJobJson({ ...machine, operations: {}, locations: {} }),
    );
  }
  expect(jobOwnerOperationRefusal(40, machine.operations.archive!, machine)).toBeNull();
  expect(jobOwnerMachine(40, machine)).toBe(machine);
  // Versions reserved by other open drafts are not accepted.
  for (const protocolVersion of [38, 39])
    expect(jobOwnerOperationRefusal(protocolVersion, machine.operations.scan!, machine)).toBe(
      "owner_protocol_unsupported",
    );
  // A machine that only ever read operator anchors has nothing an older owner can install.
  const onlyAnchored = { ...machine, operations: { archive: machine.operations.archive! } };
  expect(jobOwnerMachine(37, onlyAnchored)).toBeNull();
  // Without operator anchors, older projections keep the declaration's identity.
  const plain = { ...machine, locations: { scratch: machine.locations.scratch! } };
  plain.operations = { scan: machine.operations.scan! };
  expect(jobOwnerMachine(37, plain)).toBe(plain);

  const install = (declaration: MachineHalf): Extract<JobCommand, { type: "install" }> => ({
    type: "install",
    pluginId: "fixture.jobs",
    installationRevision: "one",
    artifactSha256: "a".repeat(64),
    machine: declaration,
    artifact: { bundleFile: "worker", data: "YQ==" },
  });
  expect(
    jobOwnerInstallRestoresProjection(install(jobOwnerMachine(37, machine)!), install(machine)),
  ).toBe(true);
  const widened = structuredClone(machine);
  widened.operations.scan!.locations = [{ locationId: "scratch", access: "write" }];
  expect(
    jobOwnerInstallRestoresProjection(install(jobOwnerMachine(37, machine)!), install(widened)),
  ).toBe(false);
});

const ownerConfig = {
  machineId: "machine",
  admissionPublicKey: "key",
  stateDirectory: "/var/lib/manifold/job-owner/state",
  delegatedCgroup: "/sys/fs/cgroup/manifold",
  bubblewrap: "/run/current-system/sw/bin/bwrap",
  protectedDirectories: ["/home"],
  anchors: { home: "/var/lib/manifold-workload/home" },
  runtimeTools: {},
  artifactOrigins: ["https://example.invalid"],
};
test("owner configuration declares operator anchors read-only, bounded and never built-in", () => {
  expect(JobOwnerConfigSchema.parse(ownerConfig)).toEqual(ownerConfig);
  const anchor = {
    path: "/run/manifold-anchors/omp-sessions",
    source: "/home/alice/.omp/agent/sessions",
    readOnly: true as const,
  };
  expect(
    JobOwnerConfigSchema.parse({
      ...ownerConfig,
      operatorAnchors: { "operator.omp-sessions": anchor },
    }).operatorAnchors,
  ).toEqual({ "operator.omp-sessions": anchor });
  expect(
    JobOwnerConfigSchema.safeParse({
      ...ownerConfig,
      operatorAnchors: { "operator.plain": { path: "/srv/plain", readOnly: true } },
    }).success,
  ).toBe(true);
  for (const operatorAnchors of [
    { "operator.omp-sessions": { ...anchor, readOnly: false } },
    { "operator.omp-sessions": { path: anchor.path, source: anchor.source } },
    { "operator.omp-sessions": { ...anchor, path: "relative" } },
    { "operator.omp-sessions": { ...anchor, writable: true } },
    { home: anchor },
    { "operator.": anchor },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`operator.a${index}`, anchor])),
  ])
    expect(JobOwnerConfigSchema.safeParse({ ...ownerConfig, operatorAnchors }).success).toBe(false);
  expect(
    JobOwnerConfigSchema.safeParse({
      ...ownerConfig,
      operatorAnchors: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`operator.a${index}`, anchor]),
      ),
    }).success,
  ).toBe(true);
  // Built-in anchors never enter the operator namespace, nor the reverse.
  expect(
    JobOwnerConfigSchema.safeParse({
      ...ownerConfig,
      anchors: { "operator.omp-sessions": "/srv/sessions" },
    }).success,
  ).toBe(false);

  const inventory = { tools: {}, services: {}, anchors: {}, serviceDefinitions: {} };
  expect(JobResourceInventorySchema.parse(inventory)).toEqual(inventory);
  expect(
    JobResourceInventorySchema.safeParse({
      ...inventory,
      anchorDefinitions: { "operator.omp-sessions": { source: anchor.source, readOnly: true } },
    }).success,
  ).toBe(true);
  expect(
    JobResourceInventorySchema.safeParse({
      ...inventory,
      anchorDefinitions: { home: { source: anchor.source, readOnly: true } },
    }).success,
  ).toBe(false);
});

const artifact = {
  url: "https://example.invalid/tool",
  sha256: "a".repeat(64),
  entrySha256: "b".repeat(64),
  format: "tar.gz",
  entry: ["main"],
  maxBytes: 4096,
  maxExpandedBytes: 8192,
  maxMembers: 8,
};

test("output-only lease backing cannot become a file, working directory or ordinary mount", () => {
  const operation = {
    argv: [],
    input: {},
    runtimeTools: [],
    locations: [{ locationId: "sample.outputs", access: "write", outputOnly: true }],
    outputs: ["answer"],
    network: "none",
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
    stdin: false,
  };
  const declaration = {
    artifacts: { "linux-x64": artifact },
    locations: { "sample.outputs": { anchor: "data", components: ["outputs"], revision: "r1" } },
    operations: { "sample.isolated": operation },
  };
  expect(MachineHalfSchema.parse(declaration).operations["sample.isolated"]!.locations).toEqual(
    operation.locations,
  );
  for (const access of ["read", "create"])
    expect(MachineOperationSchema.safeParse({
      ...operation, locations: [{ ...operation.locations[0], access }],
    }).success).toBe(false);
  expect(MachineOperationSchema.safeParse({
    ...operation, workingDirectory: { locationId: "sample.outputs" },
  }).success).toBe(false);
  expect(MachineOperationSchema.safeParse({
    ...operation,
    locations: [...operation.locations, { locationId: "sample.outputs", access: "write" }],
  }).success).toBe(false);
  expect(MachineHalfSchema.safeParse({
    ...declaration,
    locations: { "sample.outputs": { ...declaration.locations["sample.outputs"], kind: "file" } },
  }).success).toBe(false);
  expect(MachineHalfSchema.safeParse({ ...declaration, locations: {} }).success).toBe(false);
  const ordinary = { ...operation, locations: [{ locationId: "sample.outputs", access: "write" }] };
  const mixed = MachineHalfSchema.parse({
    ...declaration,
    operations: { "sample.isolated": operation, "sample.ordinary": ordinary },
  });
  expect(jobOwnerOperationRefusal(37, mixed.operations["sample.isolated"]!)).toBe(
    "output_only_locations_protocol_unsupported",
  );
  expect(jobOwnerMachine(37, mixed)?.operations).toEqual({
    "sample.ordinary": mixed.operations["sample.ordinary"],
  });
  expect(jobOwnerMachine(JOB_OWNER_PROTOCOL_VERSION, mixed)).toEqual(mixed);
  expect(jobOwnerMachine(37, MachineHalfSchema.parse(declaration))).toBeNull();
});
test("artifact executable bundles pin selected members and never admit URL credentials or raw companion files", () => {
  const files = { helper: { entry: ["bin", "helper"], sha256: "c".repeat(64) } };
  expect(MachineArtifactSchema.parse({ ...artifact, files }).files).toEqual(files);
  expect(MachineArtifactSchema.safeParse({ ...artifact, files, format: "raw" }).success).toBe(
    false,
  );
  expect(
    MachineArtifactSchema.safeParse({
      ...artifact,
      url: "https://user:secret@example.invalid/tool",
    }).success,
  ).toBe(false);
  expect(
    MachineArtifactSchema.safeParse({
      ...artifact,
      files: { helper: { entry: ["..", "tool"], sha256: "c".repeat(64) } },
    }).success,
  ).toBe(false);
});

test("machine artifacts select exactly one pinned HTTPS or flat bundle source", () => {
  const { url, ...pinned } = artifact;
  expect(
    MachineArtifactSchema.parse({ ...pinned, bundleFile: "worker-linux-x64" }).bundleFile,
  ).toBe("worker-linux-x64");
  expect(MachineArtifactSchema.safeParse(pinned).success).toBe(false);
  expect(MachineArtifactSchema.safeParse({ ...pinned, url, bundleFile: "worker" }).success).toBe(
    false,
  );
  for (const bundleFile of ["../worker", "bin/worker", ".worker", "worker\\other"]) {
    expect(MachineArtifactSchema.safeParse({ ...pinned, bundleFile }).success).toBe(false);
  }
});

test("owner-retained stdout and stderr cannot be caller-declared or rebound as filesystem outputs", () => {
  const operation = {
    argv: [],
    input: {},
    runtimeTools: ["custom-runner"],
    locations: [],
    network: "none",
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
    stdin: false,
  };
  expect(MachineOperationSchema.parse({ ...operation, outputs: ["report"] }).outputs).toEqual([
    "report",
  ]);
  for (const name of ["stdout", "stderr"]) {
    expect(MachineOperationSchema.safeParse({ ...operation, outputs: [name] }).success).toBe(false);
    expect(
      JobOutputBindingSchema.safeParse({
        name,
        locationId: "sample.worker.data",
        components: ["output"],
      }).success,
    ).toBe(false);
  }
});

test("an operation's author declares its concurrency ceiling and no request may carry one", () => {
  const perJob = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };
  const operation = {
    argv: [],
    input: {},
    runtimeTools: [],
    locations: [],
    outputs: [],
    network: "none",
    limits: perJob,
    stdin: false,
  };
  expect(MachineOperationSchema.parse(operation).limits.concurrentJobs).toBeUndefined();
  expect(
    MachineOperationSchema.parse({ ...operation, limits: { ...perJob, concurrentJobs: 1 } }).limits
      .concurrentJobs,
  ).toBe(1);
  for (const concurrentJobs of [0, -1, 1.5, 4097]) {
    expect(
      MachineOperationSchema.safeParse({ ...operation, limits: { ...perJob, concurrentJobs } })
        .success,
    ).toBe(false);
  }
  expect(JobRequestSchema.shape.limits.safeParse({ ...perJob, concurrentJobs: 2 }).success).toBe(
    false,
  );
  expect(jobLimits({ ...perJob, concurrentJobs: 2 })).toEqual(perJob);
  expect(jobLimits({ ...perJob, concurrentJobs: 2, inference: { calls: 1 } })).toEqual({
    ...perJob,
    inference: { calls: 1 },
  });
});

test("managed executables require an explicit runtime dependency and readonly inputs require string declarations", () => {
  const operation = {
    argv: [{ literal: "/inputs/config.json" }],
    input: { config: { type: "string", required: true } },
    inputFiles: { "config.json": { input: "config" } },
    executable: { runtimeTool: "engine" },
    runtimeTools: ["engine"],
    locations: [],
    outputs: [],
    network: "none",
    stdin: false,
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
  };
  expect(
    MachineHalfSchema.safeParse({
      artifacts: { "linux-x64": artifact },
      tools: { engine: { "linux-x64": artifact } },
      operations: { run: operation },
      locations: {},
    }).success,
  ).toBe(true);
  expect(MachineOperationSchema.safeParse({ ...operation, runtimeTools: [] }).success).toBe(false);
  expect(
    MachineOperationSchema.safeParse({ ...operation, executable: { path: "/bin/sh" } }).success,
  ).toBe(false);
  expect(
    MachineOperationSchema.safeParse({
      ...operation,
      input: { config: { type: "string", required: false } },
    }).success,
  ).toBe(false);
  expect(
    MachineOperationSchema.safeParse({
      ...operation,
      inputFiles: { "../config": { input: "config" } },
    }).success,
  ).toBe(false);
  expect(
    MachineOperationSchema.safeParse({ ...operation, inputFiles: { config: { input: "missing" } } })
      .success,
  ).toBe(false);
  expect(JobRequestSchema.shape.input.safeParse({ config: "é".repeat(32768) }).success).toBe(false);
});

test("a bound input is declared beside the input files it shares a namespace with, and only an own output is exported", () => {
  const operation = {
    argv: [],
    input: {},
    inputFiles: { "config.json": { literal: "{}" } },
    runtimeTools: [],
    locations: [],
    outputs: ["material", "report"],
    inputs: ["material"],
    exports: ["report"],
    network: "none",
    stdin: false,
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
  };
  expect(MachineOperationSchema.parse(operation)).toMatchObject({
    inputs: ["material"],
    exports: ["report"],
  });
  // `/inputs/config.json` is already an input file; the same name cannot also be a directory.
  expect(MachineOperationSchema.safeParse({ ...operation, inputs: ["config.json"] }).success).toBe(
    false,
  );
  expect(
    MachineOperationSchema.safeParse({ ...operation, inputs: ["material", "material"] }).success,
  ).toBe(false);
  // Exporting is a statement about this operation's OWN outputs, never another's.
  expect(MachineOperationSchema.safeParse({ ...operation, exports: ["absent"] }).success).toBe(
    false,
  );
  expect(
    MachineOperationSchema.safeParse({ ...operation, exports: ["report", "report"] }).success,
  ).toBe(false);
  expect(MachineOperationSchema.safeParse({ ...operation, exports: ["stdout"] }).success).toBe(
    false,
  );
  expect(
    MachineOperationSchema.safeParse({
      ...operation,
      inputs: Array.from({ length: 17 }, (_, index) => `bound${index}`),
    }).success,
  ).toBe(false);
});

test("a request binds a named input to one sealed output of one job, and the input ceiling only lowers", () => {
  const perJob = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };
  const request = {
    jobId: "consumer",
    machineId: "machine",
    operationId: "review",
    pluginId: "sample.consumer",
    installationRevision: "one",
    artifactSha256: "a".repeat(64),
    input: {},
    limits: { ...perJob, inputBytes: 32768 },
    outputs: [],
    inputs: [{ name: "material", from: { jobId: "producer", output: "material" } }],
    parent: null,
    credential: {
      principalId: "actor",
      tokenId: null,
      grantId: null,
      caps: ["jobs:read"],
      containerScope: null,
    },
    traceId: "trace",
    requestDigest: "b".repeat(64),
  };
  expect(JobRequestSchema.parse(request).inputs).toEqual(request.inputs);
  expect(JobRequestSchema.safeParse({ ...request, inputs: [] }).success).toBe(true);
  expect(
    JobRequestSchema.safeParse({
      ...request,
      inputs: [{ name: "material", from: { jobId: "producer" } }],
    }).success,
  ).toBe(false);
  expect(
    JobRequestSchema.safeParse({
      ...request,
      inputs: [{ name: "stdout", from: { jobId: "producer", output: "material" } }],
    }).success,
  ).toBe(false);
  expect(
    JobRequestSchema.safeParse({
      ...request,
      inputs: [{ name: "material", from: { jobId: "producer", output: "material" }, extra: 1 }],
    }).success,
  ).toBe(false);
  expect(
    JobRequestSchema.safeParse({
      ...request,
      inputs: Array.from({ length: 17 }, (_, index) => ({
        name: `bound${index}`,
        from: { jobId: "producer", output: "material" },
      })),
    }).success,
  ).toBe(false);
  expect(
    JobRequestSchema.safeParse({ ...request, limits: { ...perJob, inputBytes: 0 } }).success,
  ).toBe(false);
  // An operation's own `inputBytes` is a per-job ceiling, so no invocation edge aggregates it.
  expect(jobLimits({ ...perJob, inputBytes: 2048 })).toEqual({ ...perJob, inputBytes: 2048 });
});

test("install transport bounds all selected members together and forbids duplicate primary bytes", () => {
  const command = {
    type: "install",
    pluginId: "fixture.jobs",
    installationRevision: "one",
    artifactSha256: artifact.sha256,
    machine: {
      artifacts: { "linux-x64": artifact },
      locations: {},
      operations: {
        run: {
          argv: [],
          input: {},
          runtimeTools: [],
          locations: [],
          outputs: [],
          network: "none",
          stdin: false,
          limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
        },
      },
    },
    artifact: { bundleFile: "worker", data: "YQ==" },
    toolArtifacts: { engine: "Yg==" },
  };
  expect(JobCommandSchema.safeParse(command).success).toBe(true);
  expect(
    JobCommandSchema.safeParse({ ...command, toolArtifacts: { worker: "YQ==" } }).success,
  ).toBe(false);
  const member = "YWFh".repeat(2 * 1024 * 1024 + 1);
  expect(
    JobCommandSchema.safeParse({
      ...command,
      artifact: { bundleFile: "worker", data: member },
      toolArtifacts: { engine: member },
    }).success,
  ).toBe(false);
});

const occurrence: PublicScheduleOccurrence = {
  scheduleId: "schedule",
  revision: "schedule-revision",
  nominalAt: 100,
  jobId: "scheduled-job",
  machineId: "machine",
  pluginId: "sample.worker",
  operationId: "sample.worker.run",
  installationRevision: "retained-revision",
  artifactSha256: "a".repeat(64),
  state: "skipped",
  reason: "machine-offline",
};

test("run discovery bounds its public query and pagination without admitting authority overrides", () => {
  expect(ListJobRunsArgsSchema.parse({ machineId: "machine", limit: 100 }).limit).toBe(100);
  for (const args of [
    { machineId: "" },
    { machineId: "m".repeat(129) },
    { machineId: "machine", operationId: "" },
    { machineId: "machine", limit: 0 },
    { machineId: "machine", limit: 101 },
    { machineId: "machine", limit: 1.5 },
    { machineId: "machine", cursor: "" },
    { machineId: "machine", cursor: "c".repeat(2049) },
    { machineId: "machine", credential: { tokenId: "private" } },
    { machineId: "machine", pluginId: "other-plugin" },
  ])
    expect(ListJobRunsArgsSchema.safeParse(args).success).toBe(false);
  const run = { job: null, occurrence };
  expect(
    ListJobRunsResultSchema.parse({ runs: Array(100).fill(run), nextCursor: "opaque" }).nextCursor,
  ).toBe("opaque");
  expect(
    ListJobRunsResultSchema.safeParse({ runs: Array(101).fill(run), nextCursor: null }).success,
  ).toBe(false);
  expect(ListJobRunsResultSchema.safeParse({ runs: [], nextCursor: "" }).success).toBe(false);
});

test("occurrence-only runs expose honest skipped state and reject private persisted fields", () => {
  expect(PublicJobRunSchema.parse({ job: null, occurrence }).occurrence).toEqual(occurrence);
  expect(PublicJobRunSchema.safeParse({ job: null, occurrence: null }).success).toBe(false);
  for (const privateField of ["request", "input", "credential", "requestDigest", "permit"]) {
    expect(
      PublicScheduleOccurrenceSchema.safeParse({ ...occurrence, [privateField]: "private" })
        .success,
    ).toBe(false);
  }
  for (const invalid of [
    { nominalAt: -1 },
    { nominalAt: Number.MAX_SAFE_INTEGER + 1 },
    { state: "exited" },
    { reason: "r".repeat(2049) },
  ]) {
    expect(PublicScheduleOccurrenceSchema.safeParse({ ...occurrence, ...invalid }).success).toBe(
      false,
    );
  }
});

const job: PublicJob = {
  jobId: occurrence.jobId,
  machineId: occurrence.machineId,
  pluginId: occurrence.pluginId,
  operationId: occurrence.operationId,
  installationRevision: occurrence.installationRevision,
  artifactSha256: occurrence.artifactSha256,
  state: "queued",
  nextInputSeq: null,
  inputDigest: "a".repeat(64),
  resourceBindingDigest: "b".repeat(64),
  result: null,
  authority: {
    origin: { kind: "action", traceId: "trace", door: null },
    requester: "principal",
    executor: null,
    decision: null,
  },
};
test("a run cannot pair job metadata with a different occurrence identity or immutable pin", () => {
  expect(PublicJobRunSchema.parse({ job, occurrence }).job).toEqual(job);
  for (const field of [
    "jobId",
    "machineId",
    "pluginId",
    "operationId",
    "installationRevision",
    "artifactSha256",
  ]) {
    expect(
      PublicJobRunSchema.safeParse({
        job,
        occurrence: {
          ...occurrence,
          [field]: field === "artifactSha256" ? "b".repeat(64) : "other",
        },
      }).success,
    ).toBe(false);
  }
});

test("run discovery preserves indefinite service limits without admitting unbounded ordinary jobs", () => {
  const service: PublicJob = {
    ...job,
    limits: { timeoutMs: 0, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
    authority: {
      ...job.authority,
      origin: {
        kind: "service",
        traceId: "trace",
        door: null,
        serviceId: "broker",
        revision: "r1",
      },
    },
  };
  const result = ListJobRunsResultSchema.parse({
    runs: [{ job: service, occurrence: null }],
    nextCursor: null,
  });
  expect(result.runs[0]?.job?.limits?.timeoutMs).toBe(0);
  expect(JobLimitsSchema.safeParse(service.limits).success).toBe(false);
  expect(
    PublicJobRunSchema.safeParse({
      job: { ...service, limits: { ...service.limits, timeoutMs: -1 } },
      occurrence: null,
    }).success,
  ).toBe(false);
});
