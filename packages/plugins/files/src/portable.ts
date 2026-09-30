import type { ReactWebPluginDef } from "@manifold/plugin-kit/web";
import { FILES_ID } from "./contract.ts";
import { FileIntakePanel, FilesPanel, FilesSection } from "./web.tsx";

const filesWeb: ReactWebPluginDef = {
  id: FILES_ID,
  panels: { library: FilesPanel, intake: FileIntakePanel },
  sections: { library: FilesSection },
};

export default filesWeb;
