import { createTree, type TreeConfig, type TreeInstance } from "@headless-tree/core";
import { useEffect, useState } from "react";

interface MountableTree {
  setMounted(mounted: boolean): void;
}

/**
 * Headless Tree's React adapter stores the core's mutable state object in React state.
 * Native drag state contains ItemInstance references, and rendering that state tears down
 * the React root in React 19. Keep core state in the core and render non-drag updates only.
 */
export function useHeadlessTree<T>(config: TreeConfig<T>): TreeInstance<T> {
  const [tree] = useState(() => createTree(config));

  useEffect(() => {
    const mountable = tree as unknown as MountableTree;
    mountable.setMounted(true);
    tree.rebuildTree();
    return () => mountable.setMounted(false);
  }, [tree]);

  tree.setConfig((previous) => ({ ...previous, ...config }));
  return tree;
}
