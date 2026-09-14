import { useState, type ReactElement } from "react";
import { Stack } from "@manifold/ui";
import { RegisterAgentRequestSchema, type RegisterAgentRequest } from "@manifold/protocol";
import { ACCESS_REGISTER_AGENT_ACTION } from "./index.ts";

export function AgentRegistration({
  harnesses,
  pending,
  register,
}: {
  readonly harnesses: readonly { readonly id: string; readonly title: string }[];
  readonly pending: boolean;
  readonly register: (request: RegisterAgentRequest) => Promise<void>;
}): ReactElement {
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <form
      className="credential-agent-form"
      aria-label="Register Agent"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string): string => String(data.get(name) ?? "").trim();
        try {
          const profile: unknown = JSON.parse(text("profile") || "{}");
          const instructions = text("instructions");
          const request = RegisterAgentRequestSchema.safeParse({
            name: text("name"),
            purpose: text("purpose"),
            harness: text("harness"),
            grant: {
              caps: text("caps")
                .split(/[\s,]+/)
                .filter(Boolean),
              targets: text("targets")
                .split(/[\s,]+/)
                .filter(Boolean),
              reach: text("reach"),
              maxRunLifetimeMs: Number(text("lifetime")) * 60_000,
              delegation: {
                maxDepth: Number(text("depth")),
                maxDescendants: Number(text("descendants")),
              },
              expiresAt: new Date(text("expires")).getTime(),
            },
            context: { ...(instructions === "" ? {} : { instructions }), profile },
          });
          if (!request.success) {
            setFailure(
              request.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; "),
            );
            return;
          }
          setFailure(null);
          void register(request.data);
        } catch {
          setFailure("The harness profile must be valid JSON.");
        }
      }}
    >
      <Stack gap="0.45rem">
        <label>
          Name
          <input name="name" required maxLength={64} autoComplete="off" />
        </label>
        <label>
          Purpose
          <textarea name="purpose" required rows={2} />
        </label>
        <label>
          Harness
          <select name="harness" required>
            {harnesses.map((harness) => (
              <option key={harness.id} value={harness.id}>
                {harness.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Capabilities
          <textarea name="caps" required rows={2} placeholder="containers:read terminals:open" />
        </label>
        <label>
          Granted targets
          <textarea name="targets" required rows={2} placeholder="manifold://container/…" />
        </label>
        <label>
          Reach
          <select name="reach" defaultValue="subtree">
            <option value="node">This node</option>
            <option value="subtree">Subtree</option>
          </select>
        </label>
        <label>
          Maximum run lifetime (minutes)
          <input name="lifetime" type="number" required min={1} step={1} defaultValue={60} />
        </label>
        <label>
          Maximum delegation depth
          <input name="depth" type="number" required min={0} step={1} defaultValue={0} />
        </label>
        <label>
          Maximum descendants
          <input name="descendants" type="number" required min={0} step={1} defaultValue={0} />
        </label>
        <label>
          Standing grant expires
          <input name="expires" type="datetime-local" required />
        </label>
        <label>
          Reusable instructions
          <textarea name="instructions" rows={4} />
        </label>
        <label>
          Harness profile (JSON)
          <textarea name="profile" rows={3} defaultValue="{}" spellCheck={false} />
        </label>
        <span className="credential-inspection-note">
          The sponsor authorizes this ceiling once. Runs outside it are refused; the harness
          validates its profile.
        </span>
        {failure === null ? null : (
          <span className="credential-failure" role="alert">
            {failure}
          </span>
        )}
        <button
          className="credential-agent-control"
          type="submit"
          data-action={ACCESS_REGISTER_AGENT_ACTION}
          disabled={pending || harnesses.length === 0}
        >
          {pending ? "Registering…" : "Register Agent"}
        </button>
      </Stack>
    </form>
  );
}
