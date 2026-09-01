import type { ActionOutcome, ActionSummary } from "@manifold/protocol";
import type AjvDraft7 from "ajv";
import Form from "@rjsf/core";
import type { RJSFSchema } from "@rjsf/utils";
import { customizeValidator } from "@rjsf/validator-ajv8";
import Ajv2020 from "ajv/dist/2020.js";
import { useState, type ReactElement } from "react";

import "./door-form.css";

/**
 * ONE DOOR, AS A FORM. The fields are GENERATED from the door's published input schema —
 * the same JSON Schema `GET /api/protocol` serves and the dispatcher validates against, so
 * the form can never disagree with the door about what the door takes
 * (docs/decisions/2026-09-01-rjsf-door-forms.md: rjsf over JSON Forms, evaluation on
 * record). No schema-walking code of ours exists here; this module is the rjsf engine, its
 * validator, and the outcome rendered as the data it is.
 *
 * LOADED LAZILY, and this file is the seam: `door-forms.tsx` imports it through
 * `React.lazy`, so the form engine's whole chunk stays off the boot path until a reader
 * actually opens a door. Everything rjsf is confined behind this module's two exports.
 *
 * The submit control is ours rather than rjsf's default so it can carry
 * `data-action=<door>` — the DOM names the door it opens (invariant 12) — and so the
 * dispatch-in-flight state has one owner.
 */

/**
 * The validator, built once per module load. zod 4 publishes every action schema in the
 * 2020-12 dialect, which is not the ajv default — `AjvClass` is rjsf's documented door for
 * exactly this. The cast states structural identity TS cannot see: `Ajv2020` is the same
 * class compiled for the newer dialect, and rjsf's type names the base class.
 */
const validator = customizeValidator({
  AjvClass: Ajv2020 as unknown as typeof AjvDraft7,
});

export interface DoorFormProps {
  readonly summary: ActionSummary;
  /** THE action door, handed in: `host.client.action` bound to this door's full name. */
  readonly dispatch: (args: unknown) => Promise<ActionOutcome>;
}

export function DoorForm({ summary, dispatch }: DoorFormProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = (data: unknown): void => {
    setBusy(true);
    setOutcome(null);
    setFailure(null);
    dispatch(data)
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
