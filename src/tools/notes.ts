import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { escapeHtml } from "../utils.js";
import { ok, fail, fmtNotes } from "../formatters.js";

export function registerNoteTools(server: McpServer): void {
  server.tool(
    "zotero_get_notes",
    "Get notes for a specific item or all notes.",
    {
      item_key: z.string().optional().describe("Item key (omit for all notes)"),
      limit: z.number().default(20),
    },
    async ({ item_key, limit }) => {
      try {
        const notes = item_key
          ? (await zot.getItemChildren(item_key)).filter((c) => c.data.itemType === "note")
          : await zot.getItems({ limit, itemType: "note" });
        return ok(fmtNotes(notes, "Notes", limit));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_search_notes",
    "Search through notes content.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().default(20),
    },
    async ({ query, limit }) => {
      try {
        const items = await zot.searchItems(query, { qmode: "everything", itemType: "note", limit });
        return ok(fmtNotes(items, `Note Search: '${query}'`, limit));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_create_note",
    "Create a new note for a Zotero item. With Web API configured, creates a proper child note; otherwise uses Zotero connector.",
    {
      item_key: z.string().describe("Parent item key"),
      note_title: z.string().describe("Note title"),
      note_text: z.string().describe("Note content (plain text or HTML)"),
      tags: z.array(z.string()).optional().describe("Tags for the note"),
    },
    async ({ item_key, note_title, note_text, tags }) => {
      try {
        const parent = await zot.getItem(item_key);

        const html = note_text.includes("<p>") || note_text.includes("<div>")
          ? note_text
          : note_text.split("\n\n").map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");
        const safeTitle = escapeHtml(note_title.trim());
        const body = safeTitle ? `<h1>${safeTitle}</h1>${html}` : html;

        const result = await zot.createItemNote(item_key, body, tags ?? []);
        const via = zot.hasWebApi() ? "Web API (child note)" : "Connector (standalone)";
        return ok(
          `Note "${note_title}" created for "${parent.data.title || item_key}"\nMethod: ${via}` +
          (result !== "created-via-connector" ? `\nNote key: ${result}` : "")
        );
      } catch (e) { return fail(e); }
    }
  );
}
