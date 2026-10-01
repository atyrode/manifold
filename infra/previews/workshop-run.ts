#!/usr/bin/env bun
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hub } from "@manifold/plugin-kit/hub";
import type { Delivery } from "@manifold/plugin-kit/install";
import type { PackResult } from "@manifold/plugin-kit/pack";

type Build = (outputDir: string) => Promise<readonly PackResult[]>;
interface WorkshopModule {
  devWorkshop(options: {
    root: string;
    hub: Hub;
    deliver: Delivery;
    build?: Build;
    port: number;
  }): Promise<void>;
}
interface InstallModule {
  parseDelivery(raw: string): Delivery;
  resolveOwnerKey(file: undefined, deliver: Delivery): Promise<string>;
}
interface Configuration {
  readonly manifoldRoot: string;
  readonly sourceRoot: string;
  readonly buildModule?: string;
  readonly hubUrl: string;
  readonly frontendPort: number;
  readonly publicHost: string;
  readonly deliver: string;
}

let failureStage = "configuration";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function absolutePath(value: unknown, field: string, directory: boolean): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error(`${field} must be an absolute path`);
  }
  const canonical = await realpath(value);
  const info = await stat(canonical);
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`${field} must name a ${directory ? "directory" : "regular file"}`);
  }
  return canonical;
}

async function configuration(file: string): Promise<Configuration> {
  const value: unknown = JSON.parse(await Bun.file(file).text());
  const fields: Record<string, true> = {
    manifoldRoot: true, sourceRoot: true, buildModule: true, hubUrl: true,
    frontendPort: true, publicHost: true, deliver: true,
  };
  if (!record(value) || Object.keys(value).some((key) => !Object.hasOwn(fields, key))) {
    throw new Error("workshop config must contain only the documented non-secret fields");
  }
  // This launcher owns the integrated preview only. A different hub, delivery target or
  // public origin needs its own installation-authority and routing review.
  if (value.hubUrl !== "http://127.0.0.1:7912" || value.frontendPort !== 7913 ||
      value.publicHost !== "preview.manifold.tyrode.dev" ||
      value.deliver !== "docker:manifold-dev-manifold-1") {
    throw new Error("workshop config must select the existing integrated preview and its loopback ports");
  }
  const manifoldRoot = await absolutePath(value.manifoldRoot, "manifoldRoot", true);
  const sourceRoot = await absolutePath(value.sourceRoot, "sourceRoot", true);
  const buildModule = value.buildModule === undefined
    ? undefined
    : await absolutePath(value.buildModule, "buildModule", false);
  if (buildModule !== undefined) {
    const withinSource = relative(sourceRoot, buildModule);
    if (withinSource === ".." || withinSource.startsWith(`..${sep}`) || isAbsolute(withinSource)) {
      throw new Error("buildModule must belong to sourceRoot");
    }
  }
  await absolutePath(join(manifoldRoot, "packages/plugin-kit/src/workshop.ts"), "workshop SDK", false);
  return {
    manifoldRoot, sourceRoot, ...(buildModule === undefined ? {} : { buildModule }),
    hubUrl: value.hubUrl, frontendPort: value.frontendPort,
    publicHost: value.publicHost, deliver: value.deliver,
  };
}

async function run(config: Configuration): Promise<void> {
  // Bun's dotenv loading is disabled by the service. Do not let an inherited owner-key
  // file supersede the supported, explicitly selected delivery credential mechanism.
  delete process.env.MANIFOLD_OWNER_KEY;
  delete process.env.MANIFOLD_OWNER_KEY_FILE;
  process.env.MANIFOLD_DEV_HOST = config.publicHost;
  const sdk = join(config.manifoldRoot, "packages/plugin-kit/src");
  failureStage = "sdk-loading";
  // Both module locations are selected by the runtime configuration, not by this
  // tooling checkout: the workshop SDK and the author's pinned SDK may differ.
  const workshop: WorkshopModule = await import(pathToFileURL(join(sdk, "workshop.ts")).href);
  const installer: InstallModule = await import(pathToFileURL(join(sdk, "install.ts")).href);
  const deliver = installer.parseDelivery(config.deliver);
  let build: Build | undefined;
  if (config.buildModule !== undefined) {
    failureStage = "build-module-loading";
    const module: unknown = await import(pathToFileURL(config.buildModule).href);
    if (!record(module) || typeof module.pack !== "function") {
      throw new Error("buildModule must export pack(outputDir)");
    }
    build = module.pack as Build;
  }
  failureStage = "delivery-credential";
  const ownerKey = await installer.resolveOwnerKey(undefined, deliver);
  failureStage = "workshop-runtime";
  await workshop.devWorkshop({
    root: config.sourceRoot,
    hub: { url: config.hubUrl, ownerKey },
    deliver,
    ...(build === undefined ? {} : { build }),
    port: config.frontendPort,
  });
}

if (import.meta.main) {
  const [command, file, ...extra] = process.argv.slice(2);
  if ((command !== "validate" && command !== "run") || file === undefined || extra.length !== 0) {
    console.error("usage: bun --no-env-file infra/previews/workshop-run.ts validate|run CONFIG.json");
    process.exit(2);
  }
  try {
    const config = await configuration(file);
    if (command === "validate") console.log("workshop configuration valid; no credential resolved");
    else await run(config);
  } catch {
    // Author build code and delivery subprocess errors can contain arbitrary values.
    // Never serialize them into the persistent user journal or command output.
    console.error(`workshop launcher failed stage=${failureStage}; check config, source/SDK dependencies and supported delivery access`);
    process.exitCode = 1;
  }
}
