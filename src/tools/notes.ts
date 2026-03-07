import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { escapeHtml } from "../utils.js";
import { ok, fail, fmtNotes } from "../formatters.js";

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

        const html = content.includes("<p>") || content.includes("<div>")
          ? content
          : content.split("\n\n").map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");

        const result = await zot.createItemNote(item_key, html, tags ?? []);
        const via = zot.hasWebApi() ? "Web API" : "Connector";
        return ok(
          `Note created for "${parent.data.title || item_key}"\n` +
          `**Method:** ${via}` +
          (result !== "created-via-connector" ? `\n**Note key:** ${result}` : "")
        );
      } catch (e) { return fail(e); }
    }
  );
}
