import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from "node:fs";
import {
  canonicalJobJson,
  ServicePolicySchema,
  servicePolicyCredentialRefs,
  type JobResourceInventory,
  type JobResourceRequirements,
  type ServicePolicy,
  type ServiceCredentialReference,
} from "@manifold/protocol";
import { CLOSE_ON_EXEC, fdMountId, safeComponent, type HeldDirectory } from "./job-files.ts";
import type { LinuxJobBind } from "./job-linux.ts";

// Linux O_PATH retains symlink identity without following its target or opening a device.
const PATH_ONLY = 0x200000;
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const fingerprint = (fd: number): string => {
  const stat = fstatSync(fd, { bigint: true });
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
};

/** Native descriptors, not caller paths, define what an operator can promote. */
export class JobResources {
  policies: readonly ServicePolicy[] = [];
  private readonly inventory: JobResourceInventory = {
    tools: {},
    services: {},
    anchors: {},
    serviceDefinitions: {},
    credentialReferences: [],
  };
  private readonly files = new Map<string, string>();
  private readonly buffer = Buffer.allocUnsafe(64 * 1024);

  constructor(
    private readonly options: {
      anchors: Readonly<Record<string, HeldDirectory>>;
      runtimeTools: Readonly<Record<string, readonly LinuxJobBind[]>>;
      services?: readonly ServicePolicy[];
      credentialReferences?: () => ServiceCredentialReference[];
      runtimeAvailable?: (policy: ServicePolicy, inventory: JobResourceInventory) => boolean;
    },
  ) {
    this.configure(options.services ?? []);
    this.refresh({
      tools: Object.keys(options.runtimeTools),
      anchors: Object.keys(options.anchors),
      services: [],
    });
  }

  configure(policies: readonly ServicePolicy[]): void {
    this.policies = policies.map((policy) => ServicePolicySchema.parse(policy));
    if (new Set(this.policies.map((policy) => policy.serviceId)).size !== this.policies.length)
      throw new Error("duplicate_service_policy");
    this.refreshServices();
  }

  snapshot(): JobResourceInventory {
    return structuredClone(this.inventory);
  }

  /** Managed artifacts need no host walk; recheck only an operation's configured dependencies. */
  refresh(required: JobResourceRequirements): boolean {
    let changed = false;
    for (const name of required.tools) {
      let next: string | undefined;
      try {
        const binds = this.options.runtimeTools[name];
        if (binds)
          next = digest(
            binds.map((bind) => ({
              target: bind.target,
              writable: bind.writable,
              content: this.tree(bind.fd, fdMountId(bind.fd), 0, { entries: 0 }),
            })),
          );
      } catch {
        next = undefined;
      }
      if (this.inventory.tools[name] !== next) changed = true;
      if (next === undefined) delete this.inventory.tools[name];
      else this.inventory.tools[name] = next;
    }
    for (const name of required.anchors) {
      let next: string | undefined;
      try {
        const anchor = this.options.anchors[name];
        if (anchor) {
          const stat = fstatSync(anchor.fd, { bigint: true });
          next = digest({
            device: String(stat.dev),
            inode: String(stat.ino),
            mount: anchor.mountId,
          });
        }
      } catch {
        next = undefined;
      }
      if (this.inventory.anchors[name] !== next) changed = true;
      if (next === undefined) delete this.inventory.anchors[name];
      else this.inventory.anchors[name] = next;
    }
    return this.refreshServices() || changed;
  }

  private refreshServices(): boolean {
    const references = this.options.credentialReferences?.() ?? [];
    const sourcesAvailable = (policy: ServicePolicy, operationIds: readonly string[]) =>
      servicePolicyCredentialRefs(policy, operationIds).every((ref) =>
        references.some(
          (reference) =>
            reference.ref === ref &&
            reference.available &&
            reference.origins.includes(policy.origin!),
        ),
      );
    const candidate: JobResourceInventory = {
      ...this.inventory,
      services: {},
      serviceDefinitions: {},
      credentialReferences: references,
    };
    for (const policy of this.policies) {
      candidate.services[policy.serviceId] = digest(policy);
      candidate.serviceDefinitions[policy.serviceId] = {
        revision: policy.revision,
        operationIds: Object.keys(policy.operations)
          .filter((id) => sourcesAvailable(policy, [id]))
          .sort(),
      };
    }
    const available: Record<string, string> = {};
    for (const policy of this.policies) {
      if (!sourcesAvailable(policy, [])) continue;
      if (policy.runtime && !this.options.runtimeAvailable?.(policy, candidate)) continue;
      available[policy.serviceId] = candidate.services[policy.serviceId]!;
    }
    const changed =
      digest([
        this.inventory.services,
        this.inventory.serviceDefinitions,
        this.inventory.credentialReferences,
      ]) !== digest([available, candidate.serviceDefinitions, references]);
    this.inventory.services = available;
    this.inventory.serviceDefinitions = candidate.serviceDefinitions;
    this.inventory.credentialReferences = references;
    return changed;
  }

  private tree(fd: number, mount: number, depth: number, budget: { entries: number }): string {
    if (depth > 64 || ++budget.entries > 100_000 || fdMountId(fd) !== mount)
      throw new Error("runtime_resource_tree_refused");
    const before = fingerprint(fd);
    const stat = fstatSync(fd);
    if (stat.isSymbolicLink()) return digest({ kind: "link", identity: before });
    if (stat.isFile()) {
      const cached = this.files.get(before);
      if (cached) return cached;
      const readable = openSync(
        `/proc/self/fd/${fd}`,
        constants.O_RDONLY | constants.O_NONBLOCK | CLOSE_ON_EXEC,
      );
      try {
        if (fingerprint(readable) !== before) throw new Error("runtime_resource_changed");
        const hash = createHash("sha256");
        let offset = 0;
        for (;;) {
          const count = readSync(readable, this.buffer, 0, this.buffer.length, offset);
          if (!count) break;
          hash.update(this.buffer.subarray(0, count));
          offset += count;
        }
        if (fingerprint(readable) !== before || offset !== stat.size)
          throw new Error("runtime_resource_changed");
        const value = hash.digest("hex");
        if (this.files.size >= 100_000) this.files.clear();
        this.files.set(before, value);
        return value;
      } finally {
        closeSync(readable);
      }
    }
    if (!stat.isDirectory()) throw new Error("runtime_resource_kind_refused");
    const directory = opendirSync(`/proc/self/fd/${fd}`);
    const children: Array<[string, string]> = [];
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        safeComponent(entry.name);
        const child = openSync(
          `/proc/self/fd/${fd}/${entry.name}`,
          PATH_ONLY | CLOSE_ON_EXEC | constants.O_NOFOLLOW,
        );
        try {
          children.push([entry.name, this.tree(child, mount, depth + 1, budget)]);
        } finally {
          closeSync(child);
        }
      }
    } finally {
      directory.closeSync();
    }
    if (fingerprint(fd) !== before) throw new Error("runtime_resource_changed");
    children.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return digest(children);
  }
}
