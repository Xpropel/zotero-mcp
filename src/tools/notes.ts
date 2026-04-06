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

        const { key, via, connectorParentIgnored } = await zot.createItemNote(item_key, html, tags ?? []);
        const methodLabel = via === "connector" ? "Local (Zotero connector)" : "Web API";
        let text =
          `Note created for "${parent.data.title || item_key}"\n` +
          `**Method:** ${methodLabel}` +
          (key !== "created-via-connector" ? `\n**Note key:** ${key}` : "");
        if (connectorParentIgnored) {
          text +=
            "\n\n**Note:** Connector 写入时，Zotero 客户端会忽略独立笔记 JSON 里的 `parentItem`，笔记会进当前「保存到」的集合而不是该条目下方。" +
            "要挂在文献下（与 PDF 同级），请配置 `ZOTERO_API_KEY` + `ZOTERO_LIBRARY_ID` 并使用默认 `auto` 或 `web`（走 Web API，同步后本地库一致）。";
        } else if (via === "web") {
          text +=
            "\n\n**Note:** 笔记已写入线上库并带 `parentItem`；若本机暂未显示，请在 Zotero 中执行一次同步。";
        }
        return ok(text);
      } catch (e) { return fail(e); }
    }
  );
}
