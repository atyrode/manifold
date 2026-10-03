import { expect, test } from "bun:test";
import { isValidElement, type ReactNode } from "react";
import { SessionConnectionError, type ConnectionStatus } from "@manifold/sdk";
import { EmptyCompositionStatus } from "../src/empty-composition-status.tsx";

/** A host element as the empty cover paints it: tag, class, text and its click handler. */
interface Painted {
  readonly tag: string;
  readonly className: string | undefined;
  readonly text: string;
  readonly onClick: unknown;
}

interface PaintedProps {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly onClick?: unknown;
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
  return [
    {
      tag: node.type,
      className: node.props.className,
      text: textOf(node.props.children),
      onClick: node.props.onClick,
    },
  ];
}

const reload = (): void => {};

function cover(status: ConnectionStatus, error: SessionConnectionError | null = null): Painted[] {
  return paint(
    <EmptyCompositionStatus status={status} connectionError={error} onReload={reload} />,
  );
}

test("only progress the SDK is still making reads as progress", () => {
  expect(cover("idle")).toEqual([
    { tag: "span", className: undefined, text: "Connecting to this view…", onClick: undefined },
  ]);
  expect(cover("connecting")).toEqual(cover("idle"));
  expect(cover("reconnecting")).toEqual([
    { tag: "span", className: undefined, text: "Reconnecting to this view…", onClick: undefined },
  ]);
  expect(cover("open")).toEqual([
    { tag: "span", className: undefined, text: "Drop an item here", onClick: undefined },
  ]);
});

test("a closed session is stopped, never connecting, and offers the reload", () => {
  // A deliberate close carries no error: still stopped, with no invented reason.
  const stopped = cover("closed");
  expect(stopped).toEqual([
    {
      tag: "strong",
      className: "composition-placeholder__status",
      text: "Disconnected from this view",
      onClick: undefined,
    },
    {
      tag: "button",
      className: "chip composition-placeholder__action",
      text: "Reload to connect again",
      onClick: reload,
    },
  ]);
  // Even with a reason the cover never claims progress the closed client will not make.
  const error = new SessionConnectionError("conn-1", "ch-1", 4404, "container deleted");
  for (const painted of [stopped, cover("closed", error)]) {
    expect(painted.some((element) => element.text.includes("…"))).toBe(false);
    expect(painted.some((element) => /connecting/i.test(element.text))).toBe(false);
  }
});

test("a closed session names the reason its sticky notice reports", () => {
  const error = new SessionConnectionError("conn-1", "ch-1", 4404, "container deleted");
  const reason = cover("closed", error).find(
    (element) => element.className === "composition-placeholder__reason",
  );
  expect(reason?.tag).toBe("p");
  expect(reason?.text).toBe("container deleted");
  // The notice paints `error.message`; the cover's reason is that message's own reason.
  expect(error.message).toContain(`(4404: ${reason?.text ?? ""})`);
});
