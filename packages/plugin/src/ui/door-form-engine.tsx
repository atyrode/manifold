import Form from "@rjsf/core";
import type { RJSFSchema } from "@rjsf/utils";
import { customizeValidator } from "@rjsf/validator-ajv8";
import type { ActionOutcome } from "@manifold/protocol";
import type AjvDraft7 from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { useState, type ReactElement } from "react";

import { actionSummary } from "./action-summary.ts";
import type { DoorFormProps } from "./door-form.tsx";
import "./door-form.css";

/**
 * ONE COMPOSED DOOR, AS A GENERATED FORM. The caller names only the action; the component
 * resolves its current `ActionSummary` from the same composed protocol document exposed by
 * `GET /api/protocol`, renders that published input schema, and dispatches through the host's
 * one action door. Consumers cannot pair one action name with another action's schema.
 *
 * The public wrapper owns the lazy boundary, keeping rjsf and its validator off the boot path
 * until a reader asks to open a form (docs/decisions/2026-09-01-rjsf-door-forms.md).
 *
 * The submit control is ours rather than rjsf's default so it can carry
 * `data-action=<door>` — the DOM names the door it opens (AXIOMS.md §Foundation law and
 * REGISTRY.md §Foundation) — and so the dispatch-in-flight state has one owner.
 */

/**
 * The validator, built once per lazy module load. zod 4 publishes every action schema in the
 * 2020-12 dialect, which is not the ajv default — `AjvClass` is rjsf's documented door for
 * exactly this. The cast states structural identity TS cannot see: `Ajv2020` is the same
 * class compiled for the newer dialect, and rjsf's type names the base class.
 */
const validator = customizeValidator({
  AjvClass: Ajv2020 as unknown as typeof AjvDraft7,
});

export function DoorFormEngine({ action, host }: DoorFormProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const summary = actionSummary(action, host);

  if (summary === null) {
    return <p className="door-form__refusal">The composed protocol has no {action} door.</p>;
  }

  const submit = (data: unknown): void => {
    setBusy(true);
    setOutcome(null);
    setFailure(null);
    host.client
      .action(action, data)
      .then(setOutcome)
      .catch((reason: unknown) => {
        /* A transport failure is not a denial: denials arrive as data inside a 200. */
        setFailure(
          reason instanceof Error ? reason.message : "the dispatch did not reach the server",
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="door-form">
      <Form
        schema={summary.input as RJSFSchema}
        validator={validator}
        idPrefix={summary.name}
        showErrorList={false}
        onSubmit={({ formData }) => submit(formData ?? {})}
      >
        <button
          type="submit"
          className="door-form__submit"
          data-action={summary.name}
          disabled={busy}
        >
          {busy ? "dispatching…" : "dispatch"}
        </button>
      </Form>
      {outcome === null ? null : outcome.ok ? (
        <pre className="door-form__result">{JSON.stringify(outcome.result, null, 1)}</pre>
      ) : (
        <p className="door-form__refusal">
          <code>{outcome.denial.rule}</code> {outcome.denial.message}
        </p>
      )}
      {failure === null ? null : <p className="door-form__refusal">{failure}</p>}
    </div>
  );
}
