import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../src/auth.ts";
import { captureAuthoritySnapshot, restoreAuthoritySnapshot } from "../src/authority-snapshot.ts";
import { sourceCodeIdentity } from "../src/builtin-code-identity.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

test("unchanged entry/build labels cannot restore admission after an imported helper changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-builtin-code-"));
  const relocated = mkdtempSync(join(tmpdir(), "manifold-builtin-code-copy-"));
  const store = testStore();
  try {
    const main =
      '#!/usr/bin/env bun\nimport { authority } from "./helper.ts"; import "node:fs"; export const allowed = authority;\n';
    const helper = "export const authority = false;\n";
    for (const directory of [root, relocated]) {
      writeFileSync(join(directory, "main.ts"), main);
      writeFileSync(join(directory, "helper.ts"), helper);
    }
    const first = await sourceCodeIdentity([join(root, "main.ts")], root);
    expect(await sourceCodeIdentity([join(relocated, "main.ts")], relocated)).toBe(first);
    const auth = new AuthService(store, "builtin-code-owner", new FakeRuntime());
    const owner = auth.authenticate("builtin-code-owner");
    const snapshot = captureAuthoritySnapshot(auth, owner, {
      action: {
        actionName: "core.terminals.create",
        fingerprint: first,
        contextScope: null,
        requirements: [],
      },
    });
    expect(
      restoreAuthoritySnapshot(auth, snapshot, (binding) => binding.fingerprint === first)
        ?.principal.id,
    ).toBe(owner.principal.id);
    writeFileSync(join(root, "helper.ts"), "export const authority = true;\n");
    const current = await sourceCodeIdentity([join(root, "main.ts")], root);
    expect(current).not.toBe(first);
    expect(
      restoreAuthoritySnapshot(auth, snapshot, (binding) => binding.fingerprint === current),
    ).toBeNull();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(relocated, { recursive: true, force: true });
  }
});
