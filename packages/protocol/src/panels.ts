import { z } from "zod";
import { LocalFileDescriptorSchema, MAX_LOCAL_FILES } from "./byte-ui.ts";
import { PanelArgSchema, validPanelArg, validPanelData } from "./layout.ts";

/** Transient owner-mounted input; never a persisted tile argument or a file-byte carrier. */
export const PortablePanelInputSchema = z.strictObject({
  value: PanelArgSchema.refine(validPanelArg, "panel input must be bounded JSON data").optional(),
  files: z.array(LocalFileDescriptorSchema).max(MAX_LOCAL_FILES),
});
export type PortablePanelInput = z.infer<typeof PortablePanelInputSchema>;

/** A completed intake may include a bounded native receipt with a fully escaped path. */
export const MAX_PANEL_RESULT_BYTES = 64 * 1024;
const MAX_PANEL_RESULT_DEPTH = 32;
export const PanelResultSchema = PanelArgSchema.refine(
  (value) => validPanelData(value, MAX_PANEL_RESULT_BYTES, MAX_PANEL_RESULT_DEPTH),
  "panel result must be bounded JSON record data",
);

/** Shared across a mounted contribution's entire borrowed-panel subtree. */
export const MAX_BORROWED_PANELS = 4;
