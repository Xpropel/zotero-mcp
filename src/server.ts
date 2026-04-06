import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./tools/search.js";
import { registerItemTools } from "./tools/item.js";
import { registerFulltextTools } from "./tools/fulltext.js";
import { registerOcrTools } from "./tools/ocr.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerOrganizeTools } from "./tools/organize.js";
import { registerExportTools } from "./tools/export.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerImportTools } from "./tools/import.js";
import { registerManageTools } from "./tools/manage.js";

export const VERSION = "3.1.0";
export const server = new McpServer({ name: "Zotero", version: VERSION });

// 18 tools across 10 modules
registerSearchTools(server);      // zotero_search, zotero_recent
registerItemTools(server);        // zotero_item, zotero_save_txt
registerFulltextTools(server);    // zotero_fulltext
registerOcrTools(server);         // zotero_ocr
registerNoteTools(server);        // zotero_search_notes, zotero_create_note
registerOrganizeTools(server);    // zotero_collections, zotero_tags, zotero_batch_tags
registerExportTools(server);      // zotero_export
registerLibraryTools(server);     // zotero_libraries, zotero_feeds
registerImportTools(server);      // zotero_add
registerManageTools(server);      // zotero_duplicates, zotero_manage_collections, zotero_update
