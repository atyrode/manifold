import * as React from "react";
import * as ReactDOM from "react-dom";
import * as JSXRuntime from "react/jsx-runtime";
import * as JSXDevRuntime from "react/jsx-dev-runtime";
import * as Plugin from "@manifold/plugin";
import * as Hooks from "@manifold/plugin/hooks";
import * as UI from "@manifold/ui";
import * as Protocol from "@manifold/protocol";
import * as SDK from "@manifold/sdk";
import * as Scene from "@manifold/scene";

/** The shell's own module identities, shared with imported bundles (ADR 0025 §3). */
Object.defineProperty(globalThis, Symbol.for("manifold.shared"), {
  configurable: true,
  value: {
    react: React,
    "react-dom": ReactDOM,
    "react/jsx-runtime": JSXRuntime,
    "react/jsx-dev-runtime": JSXDevRuntime,
    "@manifold/plugin": Plugin,
    "@manifold/plugin/hooks": Hooks,
    "@manifold/ui": UI,
    "@manifold/protocol": Protocol,
    "@manifold/sdk": SDK,
    "@manifold/scene": Scene,
  },
});
