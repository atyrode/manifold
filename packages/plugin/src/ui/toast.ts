import { createContext, useContext } from "react";

/**
 * The CONSUMER half of the one notice surface: the context, its contract, and the hook.
 *
 * The application has exactly one notice stack, and it is floor — the provider that owns the
 * queue, its lifetimes, its eviction order and its DOM lives in `packages/web/src/toast.tsx`
 * and mounts above every renderer. What lives HERE is the other half of that same door: the
 * context object plus the shape a caller is allowed to see. A plugin cannot import a floor
 * module, so without this split every plugin that needs to tell a user "that was refused"
 * would grow its own notice mechanism, which is precisely the four-mechanisms-three-lifetimes
 * mess the single stack replaced.
 *
 * There is no re-export shim in either direction: the provider imports {@link ToastContext}
 * from here and supplies the value, floor and plugin callers alike take {@link useToast} from
 * here, and `ToastApi` is the whole contract between them. The queue types the provider needs
 * for its own internals stay floor, because nothing outside the provider may see a row.
 */

export type ToastLifetime = "toast" | "sticky";

export interface ToastOptions {
  /** Defaults to `"toast"`. */
  readonly lifetime?: ToastLifetime;
  /**
   * Supersession slot. A notice carrying a key that is already on screen REPLACES
   * that row where it stands rather than stacking below it; the fade timer restarts.
   */
  readonly key?: string;
}

export interface ToastApi {
  /** Shows a notice and returns its id. */
  readonly notify: (message: string, options?: ToastOptions) => string;
  /** Fades a notice out early; unknown ids are a no-op. */
  readonly dismiss: (id: string) => void;
}

/** The one notice channel. `null` means no provider is mounted, which {@link useToast} throws on. */
export const ToastContext = createContext<ToastApi | null>(null);

/**
 * Throws rather than degrading to a no-op: a notice nobody can see is exactly the
 * class of bug this module exists to end, so a missing provider must be loud.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast requires a <ToastProvider> ancestor");
  return api;
}
