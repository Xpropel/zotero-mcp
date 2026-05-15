import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTools } from "./tools/search.js";
import { registerItemTools } from "./tools/item.js";
import { registerFileTools } from "./tools/files.js";
import { registerOcrTools } from "./tools/ocr.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerOrganizeTools } from "./tools/organize.js";
import { registerExportTools } from "./tools/export.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerImportTools } from "./tools/import.js";
import { registerManageTools } from "./tools/manage.js";

export const VERSION = "3.3.0";
export const server = new McpServer({ name: "Zotero", version: VERSION });

// 23 focused tools across 11 modules
registerSearchTools(server);      // zotero_search
registerItemTools(server);        // zotero_item
registerFileTools(server);        // zotero_read_file, zotero_manage_files
registerOcrTools(server);         // zotero_ocr
registerNoteTools(server);        // zotero_search_notes, zotero_create_note, zotero_manage_notes
registerAttachmentTools(server);  // zotero_manage_attachments
registerOrganizeTools(server);    // zotero_collections, zotero_tags, zotero_batch_tags, zotero_manage_tags
registerExportTools(server);      // zotero_export
registerLibraryTools(server);     // zotero_capabilities, zotero_libraries
registerImportTools(server);      // zotero_add
registerManageTools(server);      // zotero_create_item, zotero_duplicates, zotero_manage_collections, zotero_delete_items, zotero_move_items, zotero_update
