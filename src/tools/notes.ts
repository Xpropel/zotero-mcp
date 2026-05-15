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
    "zotero_notes",
    "List, search, create, update, append to, or delete Zotero notes.",
    {
      action: z.enum(["list", "search", "create", "update", "append", "delete"]).describe("Action to perform"),
      query: z.string().optional().describe("Search query for search action"),
      item_key: z.string().optional().describe("Parent item key for list/create"),
      note_key: z.string().optional().describe("Note item key for update/append/delete"),
      content: z.string().optional().describe("Plain text or HTML note content"),
      tags: z.array(z.string()).optional().describe("Tags for create/update; update replaces note tags"),
      limit: z.number().default(20).describe("Max notes for search/list output"),
      confirm: z.boolean().default(false).describe("Required true for delete action"),
      permanent: z.boolean().default(false).describe("When true, permanently erase instead of moving to Zotero trash"),
    },
    async ({ action, query, item_key, note_key, content, tags, limit, confirm, permanent }) => {
      try {
        if (action === "search") {
          if (!query) return fail(new Error("query is required for search action"));
          const items = await zot.searchItems(query, { qmode: "everything", itemType: "note", limit });
          return ok(fmtNotes(items, `Note Search: "${query}"`, limit));
        }

        if (action === "list") {
          if (!item_key) return fail(new Error("item_key is required for list action"));
          const children = await zot.getItemChildren(item_key);
          const notes = children.filter((child) => child.data.itemType === "note");
          return ok(fmtNotes(notes, `Notes for [${item_key}]`, limit));
        }

        if (action === "create") {
          if (!item_key) return fail(new Error("item_key is required for create action"));
          if (!content) return fail(new Error("content is required for create action"));
          const parent = await zot.getItem(item_key);
          const { key } = await zot.createItemNote(item_key, toNoteHtml(content), tags ?? []);
          return ok(
            `Note created for "${parent.data.title || item_key}"\n` +
              "**Method:** Local bridge\n" +
              `**Note key:** [${key}]`
          );
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
      } catch (e) {
        return fail(e);
      }
    }
  );
}
