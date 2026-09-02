import { createTree, type TreeConfig, type TreeInstance } from "@headless-tree/core";
import { useEffect, useMemo, useState } from "react";

interface MountableTree {
  setMounted(mounted: boolean): void;
}

/**
 * Headless Tree's React adapter stores the core's mutable state object in React state.
 * Native drag state contains ItemInstance references, and rendering that state tears down
 * the React root in React 19. Keep core state in the core and render non-drag updates only.
 *
 * `data` is whatever the caller's item lookup answers from — a value, so a change to it is
 * comparable, and it comes FIRST so the config keeps its place as the call's trailing object.
 * It exists because a rebuild is the ONLY way new data reaches `tree.getItems()`, and the
 * caller renders those items in this pass: rebuilding after the commit instead would leave
 * the rows one render behind the data — invisible while a poll re-rendered the section every
 * couple of seconds, and a row that never appears now that nothing does.
 */
export function useHeadlessTree<T>(data: unknown, config: TreeConfig<T>): TreeInstance<T> {
  const [tree] = useState(() => createTree(config));

  useEffect(() => {
    const mountable = tree as unknown as MountableTree;
    mountable.setMounted(true);
    tree.rebuildTree();
    return () => mountable.setMounted(false);
  }, [tree]);

  tree.setConfig((previous) => ({ ...previous, ...config }));
  /*
    Beside `setConfig` and for the same reason: the core is synchronised DURING render, so
    what the caller paints is what the data just said. The memo's value IS the data it was
    built from, which is what makes the dependency a fact rather than a hint.
  */
  useMemo(() => {
    tree.rebuildTree();
    return data;
  }, [tree, data]);
  return tree;
}
