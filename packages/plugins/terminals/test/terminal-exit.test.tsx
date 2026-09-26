import { expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { TERMINAL_EXIT_REASONS } from "@manifold/protocol";
import { TerminalExitStatus, terminalExitExplanation } from "../src/terminal-exit.tsx";

/** A host element as the exited cover paints it: tag, class and its text. */
interface Painted {
  readonly tag: string;
  readonly className: string | undefined;
  readonly text: string;
}

interface PaintedProps {
  readonly children?: ReactNode;
  readonly className?: string;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<PaintedProps>(node)) return textOf(node.props.children);
  return "";
}

/** Evaluates function components and fragments down to the host elements a browser receives. */
function paint(node: ReactNode): Painted[] {
  if (Array.isArray(node)) return node.flatMap(paint);
  if (!isValidElement<PaintedProps>(node)) return [];
  if (typeof node.type === "function") {
    const render = node.type as (props: PaintedProps) => ReactNode;
    return paint(render(node.props));
  }
  if (typeof node.type !== "string") return paint(node.props.children);
  return [{ tag: node.type, className: node.props.className, text: textOf(node.props.children) }];
}

test("an ordinary exit reads exactly as before: a status and no owner sentence", () => {
  expect(paint(<TerminalExitStatus exitCode={7} exitReason={null} />)).toEqual([
    { tag: "span", className: undefined, text: "exited (7)" },
  ]);
  expect(paint(<TerminalExitStatus exitCode={null} exitReason={null} />)).toEqual([
    { tag: "span", className: undefined, text: "exited" },
  ]);
});

test("every owner reason adds its own sentence under the status", () => {
  const sentences = TERMINAL_EXIT_REASONS.map((exitReason) => {
    const painted = paint(<TerminalExitStatus exitCode={1} exitReason={exitReason} />);
    expect(painted).toEqual([
      { tag: "span", className: undefined, text: "exited (1)" },
      { tag: "p", className: "terminal-exit-reason", text: terminalExitExplanation(exitReason) },
    ]);
    return painted[1]!.text;
  });
  expect(new Set(sentences).size).toBe(TERMINAL_EXIT_REASONS.length);
  expect(terminalExitExplanation("owner_oom_stopped")).toContain("out-of-memory");
  expect(terminalExitExplanation("owner_stopped")).not.toContain("out-of-memory");
});
