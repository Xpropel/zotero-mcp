import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./tools/search.js";
import { registerItemTools } from "./tools/item.js";
import { registerFileTools } from "./tools/files.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerTagTools } from "./tools/tags.js";
import { registerExportTools } from "./tools/export.js";
import { registerStatusTools } from "./tools/status.js";
import { registerItemManagementTools } from "./tools/items.js";

export const VERSION = "3.4.0";
export const server = new McpServer({ name: "Zotero", version: VERSION });

// 9 consolidated tools. Domain writes are grouped by action parameters.
registerStatusTools(server);          // zotero_status
registerSearchTools(server);          // zotero_search
registerItemTools(server);            // zotero_item
registerItemManagementTools(server);  // zotero_items
registerFileTools(server);            // zotero_files
registerNoteTools(server);            // zotero_notes
registerCollectionTools(server);      // zotero_collections
registerTagTools(server);             // zotero_tags
registerExportTools(server);          // zotero_export
