import * as react from "react";
import * as reactDom from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as plugin from "@manifold/plugin";
import * as hooks from "@manifold/plugin/hooks";
import * as ui from "@manifold/ui";
import * as protocol from "@manifold/protocol";
import * as sdk from "@manifold/sdk";
import * as scene from "@manifold/scene";

// Installed modules use the hub's own namespace objects, never a second floor copy.
Object.defineProperty(globalThis, Symbol.for("manifold.shared"), {
  configurable: true,
  value: Object.freeze({
    react,
    "react-dom": reactDom,
    "react/jsx-runtime": jsxRuntime,
    "react/jsx-dev-runtime": jsxDevRuntime,
    "@manifold/plugin": plugin,
    "@manifold/plugin/hooks": hooks,
    "@manifold/ui": ui,
    "@manifold/protocol": protocol,
    "@manifold/sdk": sdk,
    "@manifold/scene": scene,
  }),
});
