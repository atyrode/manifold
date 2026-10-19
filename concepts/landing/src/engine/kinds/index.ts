// The kind registry: every kind a document may hold, in a fixed order (a kind's index is its row of
// the instance texture, src/engine/instances.ts), and their code, loaded once a document first holds
// the kind (`loadKindCode`) and read back without waiting by the program's assembly (`kindCode`).
import { effective } from "../../params.ts";
import type { KindCode, KindDef, Placed } from "../types.ts";
import { blockKind } from "./block/index.ts";
import { groundKind } from "./ground/index.ts";
import { lampKind } from "./lamp/index.ts";
import { sphereKind } from "./sphere/index.ts";

export const kinds: readonly KindDef[] = [groundKind, blockKind, sphereKind, lampKind];

const byId: Readonly<Record<string, KindDef>> = Object.fromEntries(
  kinds.map((kind) => [kind.id, kind]),
);

export function kindById(id: string): KindDef | undefined {
  return byId[id];
}

/** A kind's row of the instance texture, past the header row: its index in `kinds`, plus one. */
export function kindRow(kind: KindDef): number {
  return kinds.indexOf(kind) + 1;
}

/** Every option of `placed` as its kind reads it: its own value, else the option's default. */
export function optionValues(kind: KindDef, placed: Placed): Record<string, number> {
  const own = { ...placed.options };
  return Object.fromEntries(kind.options.map((def) => [def.key, effective(def, own)]));
}

const loaded = new Map<string, KindCode>();
const loading = new Map<string, Promise<KindCode>>();

/** Kind `id`'s code, loaded the first time it is asked for; a failed load is tried again next time. */
export function loadKindCode(kind: KindDef): Promise<KindCode> {
  let load = loading.get(kind.id);
  if (load === undefined) {
    load = kind.code().then(
      (code) => {
        loaded.set(kind.id, code);
        return code;
      },
      (error: unknown) => {
        loading.delete(kind.id);
        throw error;
      },
    );
    loading.set(kind.id, load);
  }
  return load;
}

/** Kind `id`'s code once it has loaded (`loadKindCode`), else undefined. */
export function kindCode(id: string): KindCode | undefined {
  return loaded.get(id);
}
