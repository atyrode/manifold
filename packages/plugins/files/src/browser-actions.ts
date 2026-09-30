import type { PortableHostServices } from "@manifold/plugin";
import type { z } from "zod";
import { filesActions } from "./index.ts";
import { FILES_ID } from "./contract.ts";

export type FileActionName = (typeof filesActions)[number]["name"];

/** Transport failure is not evidence that a mutating action did not commit. */
export class FilesActionError extends Error {
  constructor(
    readonly reason: string,
    readonly uncertain = false,
  ) {
    super(reason);
    this.name = "FilesActionError";
  }
}

export function fileFailure(error: unknown): string {
  return error instanceof Error ? error.message : "The operation could not be confirmed.";
}

export async function fileAction<T>(
  host: PortableHostServices,
  name: FileActionName,
  args: unknown,
  result: z.ZodType<T>,
): Promise<T> {
  const declaration = filesActions.find((candidate) => candidate.name === name);
  if (!declaration) throw new FilesActionError("Unknown Files action.");
  const input = declaration.input.safeParse(args);
  if (!input.success)
    throw new FilesActionError("Invalid input. Review the exact name, principal or path.");
  let outcome;
  try {
    outcome = await host.client.action(`${FILES_ID}.${name}`, input.data);
  } catch {
    throw new FilesActionError(
      "Connection interrupted; the operation's outcome is unconfirmed.",
      true,
    );
  }
  if (!outcome.ok) throw new FilesActionError(outcome.denial.message);
  if (
    typeof outcome.result === "object" &&
    outcome.result !== null &&
    "refused" in outcome.result
  ) {
    const reason =
      typeof outcome.result.refused === "string" ? outcome.result.refused : "unavailable";
    throw new FilesActionError(reason, reason.includes("unknown"));
  }
  const parsed = result.safeParse(outcome.result);
  if (!parsed.success)
    throw new FilesActionError("The response could not be verified; outcome unconfirmed.", true);
  return parsed.data;
}
