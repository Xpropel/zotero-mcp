import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import * as zot from "../zotero-client.js";
import { resolveItemFiles } from "../utils.js";
import { ok, fail, suggestNext } from "../formatters.js";

const MAX_CHARS = 200_000; // ~50K tokens, safe for most LLMs

export function registerFulltextTools(server: McpServer): void {
  server.tool(
    "zotero_fulltext",
    "Read the full text of a Zotero item for LLM analysis. " +
      "Automatically selects the best available source: Markdown (.md, preserves structure) > " +
      "Plain text (.txt) > Zotero indexed fulltext. " +
      "If no text is available, shows PDF path and suggests running zotero_ocr first.",
    {
      item_key: z.string().describe("Zotero item key"),
      max_chars: z
        .number()
        .optional()
        .describe("Max characters to return (default: 200000). Use smaller values for summaries."),
      source: z
        .enum(["auto", "md", "txt", "index"])
        .default("auto")
        .describe("Force a specific source: auto (best available), md, txt, or index (Zotero fulltext index)"),
    },
    async ({ item_key, max_chars, source }) => {
      try {
        const limit = max_chars ?? MAX_CHARS;
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);
        const att = zot.findBestAttachment(children);

        const title = item.data.title || "Untitled";
        let text: string | null = null;
        let usedSource = "";

        if (att) {
          const files = resolveItemFiles(
            att.key,
            typeof att.path === "string" ? att.path : undefined
          );

          // Source selection: MD > TXT > Zotero index
          if ((source === "auto" || source === "md") && files.mdPath) {
            text = readFileSync(files.mdPath, "utf-8");
            usedSource = "md";
          }

          if (!text && (source === "auto" || source === "txt") && files.txtPath) {
            text = readFileSync(files.txtPath, "utf-8");
            usedSource = "txt";
          }

          if (!text && (source === "auto" || source === "index")) {
            // Try Zotero's own fulltext index
            const ft = await zot.getItemFulltext(att.key);
            if (ft?.content) {
              text = ft.content;
              usedSource = "index";
            }
          }

          if (!text) {
            // No text available
            const hint = files.pdfPath
              ? `PDF 路径: ${files.pdfPath}\n\n请先运行 \`zotero_ocr\` 将 PDF 转换为可读文本。`
              : "未找到 PDF 或文本文件。";
            return ok(
              `# ${title}\n**Key:** ${item_key}\n\n⚠️ 无可读全文\n${hint}\n\n${suggestNext("item_no_ocr")}`
            );
          }
        } else {
          return fail(new Error(`Item [${item_key}] has no attachments.`));
        }

        // Truncate if needed
        const truncated = text.length > limit;
        const content = truncated ? text.slice(0, limit) : text;

        const header = [
          `# ${title}`,
          `**Key:** ${item_key} | **Source:** ${usedSource} | **Characters:** ${text.length.toLocaleString()}${truncated ? ` (truncated to ${limit.toLocaleString()})` : ""}`,
          "",
          "---",
          "",
        ].join("\n");

        return ok(header + content + (truncated ? "\n\n... [truncated]" : "") + "\n\n" + suggestNext("item"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
