import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./tools/search.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerAnnotationTools } from "./tools/annotations.js";
import { registerLibraryTools } from "./tools/library.js";

export const server = new McpServer({ name: "Zotero", version: "1.0.0" });

registerSearchTools(server);
registerMetadataTools(server);
registerNoteTools(server);
registerAnnotationTools(server);
registerLibraryTools(server);
