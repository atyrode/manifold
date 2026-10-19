// The document the canvas scene shows (src/scenes/canvas): one a page, as the page has one canvas.
// The scene's features read its program's features from here, its sim the document to upload. A
// document goes up only once the code of every kind it holds has loaded (`show`), so the program
// its features ask for can always be assembled.
import { landDoc } from "./docs.ts";
import { kindById, kindCode, loadKindCode } from "./kinds/index.ts";
import { engineFeatures } from "./program.ts";
import type { EngineDoc } from "./types.ts";

export class EngineStage {
  #doc: EngineDoc;
  #features: Readonly<Record<string, number>>;
  /** The document last asked for, which shows once its kinds' code has loaded. */
  #asked: EngineDoc;

  constructor(doc: EngineDoc) {
    this.#doc = doc;
    this.#asked = doc;
    this.#features = engineFeatures(doc);
  }

  /** The document on screen. */
  get doc(): EngineDoc {
    return this.#doc;
  }

  /** Its program's features (src/engine/program.ts `engineFeatures`). */
  get features(): Readonly<Record<string, number>> {
    return this.#features;
  }

  /**
   * Show `doc` once the code of every kind it holds has loaded: at once if it has, and `shown` is
   * called then; unless another document is asked for meanwhile. Throws (without showing it) for a
   * document whose program cannot be keyed: an unknown kind, too many objects of one.
   */
  show(doc: EngineDoc, shown: () => void): void {
    const features = engineFeatures(doc);
    this.#asked = doc;
    const held = [...new Set(doc.objects.map((placed) => placed.kind))].flatMap((id) => {
      const kind = kindById(id);
      return kind === undefined ? [] : [kind];
    });
    const put = () => {
      if (this.#asked !== doc) return;
      this.#doc = doc;
      this.#features = features;
      shown();
    };
    if (held.every((kind) => kindCode(kind.id) !== undefined)) {
      put();
      return;
    }
    Promise.all(held.map((kind) => loadKindCode(kind))).then(put, (error: unknown) => {
      console.error("evt=landing.engine.kind_code_failed", error);
    });
  }

  /** The code of every kind the document on screen holds: loaded before the scene's code runs. */
  ready(): Promise<unknown> {
    return Promise.all(
      this.#doc.objects.flatMap((placed) => {
        const kind = kindById(placed.kind);
        return kind === undefined ? [] : [loadKindCode(kind)];
      }),
    );
  }
}

/** The page's stage, showing the `land` document until told otherwise. */
export const engineStage = new EngineStage(landDoc);
