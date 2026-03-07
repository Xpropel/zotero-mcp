import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./tools/search.js";
import { registerItemTools } from "./tools/item.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerOrganizeTools } from "./tools/organize.js";
import { registerExportTools } from "./tools/export.js";
import { registerLibraryTools } from "./tools/library.js";

export const server = new McpServer({ name: "Zotero", version: "2.0.0" });

registerSearchTools(server);
registerItemTools(server);
registerNoteTools(server);
registerOrganizeTools(server);
registerExportTools(server);
registerLibraryTools(server);
