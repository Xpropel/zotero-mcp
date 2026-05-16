import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./tools/search.js";
import { registerItemTools } from "./tools/item.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerTextTools } from "./tools/texts.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerTagTools } from "./tools/tags.js";
import { registerExportTools } from "./tools/export.js";
import { registerStatusTools } from "./tools/status.js";
import { registerItemManagementTools } from "./tools/items.js";
import { registerImportTools } from "./tools/import.js";

export const VERSION = "3.5.1";
export const server = new McpServer({ name: "Zotero", version: VERSION });

// 11 semantic tools. Parameters stay scoped to one Zotero object boundary.
registerStatusTools(server);          // zotero_status
registerSearchTools(server);          // zotero_search
registerItemTools(server);            // zotero_item
registerItemManagementTools(server);  // zotero_items
registerImportTools(server);          // zotero_import
registerAttachmentTools(server);      // zotero_attachments
registerTextTools(server);            // zotero_texts
registerNoteTools(server);            // zotero_notes
registerCollectionTools(server);      // zotero_collections
registerTagTools(server);             // zotero_tags
registerExportTools(server);          // zotero_export
