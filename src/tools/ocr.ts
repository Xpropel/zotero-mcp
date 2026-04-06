import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { statSync } from "node:fs";
import * as zot from "../zotero-client.js";
import { resolveItemFiles } from "../utils.js";
import { ocrPdf, saveOcrResult, saveOcrImages } from "../paddle-ocr.js";
import type { OcrFormat } from "../paddle-ocr.js";
import { ok, fail } from "../formatters.js";

export function registerOcrTools(server: McpServer): void {
  server.tool(
    "zotero_ocr",
    "Convert a Zotero item's PDF to text using PaddleOCR (layout-aware OCR). " +
      "Outputs Markdown (.md), structured JSON (.json), or plain text (.txt) alongside the PDF in Zotero storage. " +
      "Use format='md' for best LLM readability (preserves headings, tables, lists). " +
      "Check zotero_item first — if TXT/MD already exists, no need to re-run OCR.",
    {
      item_key: z.string().describe("Zotero item key"),
      format: z
        .enum(["md", "json", "txt"])
        .default("md")
        .describe("Output format: md (Markdown, best for LLM), json (structured), txt (plain text)"),
      save_images: z
        .boolean()
        .default(false)
        .describe("Also download and save images extracted from PDF"),
    },
    async ({ item_key, format, save_images }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);
        const att = zot.findBestAttachment(children);

        if (!att) return fail(new Error("No attachment found for this item."));

        const files = resolveItemFiles(
          att.key,
          typeof att.path === "string" ? att.path : undefined
        );

        if (!files.pdfPath)
          return fail(new Error("PDF file not found on disk."));

        const title = item.data.title || "Untitled";
        const lines: string[] = [`OCR 处理: "${title}"`, ""];

        // 调用 PaddleOCR
        lines.push("正在调用 PaddleOCR API...");
        const result = await ocrPdf(files.pdfPath);
        lines.pop(); // remove "正在调用" line

        // 保存结果
        const savePath = saveOcrResult(files.pdfPath, result, format as OcrFormat);
        const size = statSync(savePath).size;

        lines.push(`**Item:** ${title} [${item_key}]`);
        lines.push(`**Pages:** ${result.pages.length}`);
        lines.push(`**Format:** ${format}`);
        lines.push(`**Saved:** ${savePath} (${(size / 1024).toFixed(1)} KB)`);
        lines.push(`**Characters:** ${result.fullText.length.toLocaleString()}`);

        // 同时保存 txt 版本（如果输出格式不是 txt），方便 zotero_item 检测
        if (format !== "txt") {
          const txtPath = saveOcrResult(files.pdfPath, result, "txt");
          const txtSize = statSync(txtPath).size;
          lines.push(
            `**TXT backup:** ${txtPath} (${(txtSize / 1024).toFixed(1)} KB)`
          );
        }

        // 保存图片
        if (save_images) {
          const imgPaths = await saveOcrImages(files.pdfPath, result);
          if (imgPaths.length) {
            lines.push(`**Images saved:** ${imgPaths.length} files`);
          }
        }

        lines.push(
          "",
          "下次调用 zotero_item 时将自动显示 TXT 可用。可直接读取转换后的文件。"
        );

        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
