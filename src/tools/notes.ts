import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { escapeHtml } from "../utils.js";
import { ok, fail, fmtNotes } from "../formatters.js";

function toNoteHtml(content: string): string {
  return content.includes("<p>") || content.includes("<div>")
    ? content
    : content.split("\n\n").map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");
}

export function registerNoteTools(server: McpServer): void {
  server.tool(
    "zotero_search_notes",
    "Search through note contents across the library. Useful to check if a paper has already been summarized.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().default(20).describe("Max results"),
    },
    async ({ query, limit }) => {
      try {
        const items = await zot.searchItems(query, { qmode: "everything", itemType: "note", limit });
        return ok(fmtNotes(items, `Note Search: "${query}"`, limit));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_create_note",
    "Create a note for a Zotero item. Use this after reading a paper (via PaddleOCR) to save your summary back to Zotero.",
    {
      item_key: z.string().describe("Parent item key"),
      content: z.string().describe("Note content (plain text or HTML)"),
      tags: z.array(z.string()).optional().describe("Tags for the note"),
    },
    async ({ item_key, content, tags }) => {
      try {
        const parent = await zot.getItem(item_key);

        const html = toNoteHtml(content);
        const { key } = await zot.createItemNote(item_key, html, tags ?? []);
        let text =
          `Note created for "${parent.data.title || item_key}"\n` +
          `**Method:** Local bridge\n` +
          `**Note key:** [${key}]`;
        return ok(text);
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_manage_notes",
    "List, update, append to, or delete Zotero notes. Create new notes with zotero_create_note.",
    {
      action: z.enum(["list", "update", "append", "delete"]).describe("Action to perform"),
      item_key: z.string().optional().describe("Parent item key for list action"),
      note_key: z.string().optional().describe("Note item key for update/append/delete"),
      content: z.string().optional().describe("Plain text or HTML note content for update/append"),
      tags: z.array(z.string()).optional().describe("Replace note tags on update"),
      confirm: z.boolean().default(false).describe("Required true for delete action"),
      permanent: z.boolean().default(false).describe("When true, permanently erase instead of moving to Zotero trash"),
    },
    async ({ action, item_key, note_key, content, tags, confirm, permanent }) => {
      try {
        if (action === "list") {
          if (!item_key) return fail(new Error("item_key is required for list action"));
          const children = await zot.getItemChildren(item_key);
          const notes = children.filter((child) => child.data.itemType === "note");
          return ok(fmtNotes(notes, `Notes for [${item_key}]`, notes.length || 20));
        }

        if (action === "update") {
          if (!note_key) return fail(new Error("note_key is required for update action"));
          if (content === undefined && tags === undefined) {
            return fail(new Error("Provide content or tags for update action"));
          }
          if (content !== undefined) {
            await zot.updateNote(note_key, toNoteHtml(content), tags);
          } else {
            const note = await zot.getItem(note_key);
            await zot.updateNote(note_key, note.data.note || "", tags);
          }
          return ok(`Note [${note_key}] updated locally`);
        }

        if (action === "append") {
          if (!note_key) return fail(new Error("note_key is required for append action"));
          if (!content) return fail(new Error("content is required for append action"));
          await zot.appendToNote(note_key, toNoteHtml(content));
          return ok(`Appended content to note [${note_key}]`);
        }

        if (action === "delete") {
          if (!note_key) return fail(new Error("note_key is required for delete action"));
          const note = await zot.getItem(note_key);
          if (note.data.itemType !== "note") return fail(new Error(`Item is not a note: ${note_key}`));
          if (!confirm) {
            return ok(
              `Delete preview: note [${note_key}] under [${note.data.parentItem || "unknown parent"}].\n` +
                "Run again with confirm=true to delete it."
            );
          }
          await zot.deleteItem(note_key, permanent);
          return ok(`Deleted note [${note_key}]`);
        }

        return fail(new Error(`Unknown action: ${action}`));
      } catch (e) { return fail(e); }
    }
  );
}
