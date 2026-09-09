import { closeSync } from "node:fs";
import type { MachineOperation, JobRequest } from "@manifold/protocol";
import { privateByteFile } from "./job-files.ts";
import type { LinuxJobBind } from "./job-linux.ts";

export interface JobServiceEndpoint {
  readonly url: string;
  readonly bearer: string;
}

function replaceJsonValue(root: unknown, path: readonly string[], value: string): void {
  let visited = 0;
  let replaced = 0;
  const walk = (node: unknown, index: number): void => {
    if (++visited > 8192 || node === null || typeof node !== "object")
      throw new Error("input_service_path_refused");
    const part = path[index]!;
    const keys = part === "*" ? Object.keys(node) : [part];
    for (const key of keys) {
      if (!Object.hasOwn(node, key)) throw new Error("input_service_path_missing");
      if (index + 1 === path.length) {
        if (typeof Reflect.get(node, key) !== "string")
          throw new Error("input_service_value_invalid");
        Reflect.set(node, key, value);
        replaced++;
      } else walk(Reflect.get(node, key), index + 1);
    }
  };
  walk(root, 0);
  if (!replaced) throw new Error("input_service_path_missing");
}

/** Only the owner substitutes native capabilities; the request and durable journal never contain them. */
export function materializeJobInputs(
  operation: MachineOperation,
  input: JobRequest["input"],
  endpoints: ReadonlyMap<string, JobServiceEndpoint>,
  serviceBearer?: string,
): LinuxJobBind[] {
  const files: LinuxJobBind[] = [];
  let total = 0;
  try {
    for (const [name, declaration] of Object.entries(operation.inputFiles ?? {})) {
      let value: unknown =
        declaration.input === undefined ? declaration.literal : input[declaration.input];
      if (declaration.generated) {
        if (!serviceBearer) throw new Error("service_runtime_parent_required");
        value = JSON.stringify(serviceBearer);
      }
      if (typeof value !== "string") throw new Error("input_file_string_required");
      if (declaration.jsonValues?.length) {
        const json: unknown = JSON.parse(value);
        for (const replacement of declaration.jsonValues) {
          const endpoint = endpoints.get(replacement.serviceId);
          if (!endpoint) throw new Error("input_service_unavailable");
          replaceJsonValue(json, replacement.path, endpoint[replacement.value]);
        }
        value = JSON.stringify(json);
      }
      const bytes = Buffer.from(value as string);
      try {
        total += bytes.length;
        if (total > 65536) throw new Error("input_file_byte_limit");
        files.push({
          fd: privateByteFile(bytes),
          target: declaration.homePath
            ? `/home/job/${declaration.homePath.join("/")}`
            : `/inputs/${name}`,
          writable: false,
        });
      } finally {
        bytes.fill(0);
      }
    }
    return files;
  } catch (error) {
    for (const file of files) closeSync(file.fd);
    throw error;
  }
}
