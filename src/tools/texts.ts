import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import * as zot from "../zotero-client.js";
import { ocrPdf, saveOcrImages, saveOcrResult } from "../paddle-ocr.js";
import type { OcrFormat } from "../paddle-ocr.js";
import { resolveItemFiles, suggestTxtFilename } from "../utils.js";
import { ok, fail, suggestNext } from "../formatters.js";

const MAX_CHARS = 200_000;

function selectAttachment(children: Awaited<ReturnType<typeof zot.getItemChildren>>, attachmentKey?: string) {
  if (attachmentKey) {
    const attachment = children.find((child) => child.key === attachmentKey && child.data.itemType === "attachment");
    if (!attachment) throw new Error(`Attachment not found under item: ${attachmentKey}`);
    return zot.findBestAttachment([attachment]);
  }
  return zot.findBestAttachment(children);
}

function fileNameFor(format: "md" | "txt", basePath: string, filename?: string): string {
  if (filename) return filename;
  if (format === "txt") return suggestTxtFilename(basePath);
  return basename(basePath, extname(basePath)) + ".md";
}

export function registerTextTools(server: McpServer): void {
  server.tool(
    "zotero_texts",
    "Manage LLM-readable text for Zotero attachments: list sidecars, read MD/TXT/index text, write text, import a sidecar file, or OCR a PDF.",
    {
      action: z.enum(["list", "read", "write", "import", "ocr"]).default("read"),
      item_key: z.string().describe("Parent Zotero item key"),
      attachment_key: z.string().optional().describe("Specific attachment key. Omit to use the best attachment."),
      source: z.enum(["auto", "md", "txt", "index"]).default("auto").describe("For read: text source"),
      format: z.enum(["md", "txt", "json"]).optional().describe("For write/import/OCR: target format"),
      content: z.string().optional().describe("For write: text content"),
      source_path: z.string().optional().describe("For import: existing .md/.txt file to copy into Zotero storage"),
      filename: z.string().optional().describe("Optional target sidecar filename"),
      max_chars: z.number().optional().describe("For read: max characters to return. Default 200000."),
      save_images: z.boolean().default(false).describe("For OCR: save extracted images when supported"),
    },
    async ({ action, item_key, attachment_key, source, format, content, source_path, filename, max_chars, save_images }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);

        if (action === "list") {
          const attachments = children.filter((child) =>
            child.data.itemType === "attachment" && (!attachment_key || child.key === attachment_key)
          );
          if (!attachments.length) return ok(`No attachments found for item [${item_key}].`);
          const lines = [
            `# Text Inventory: ${item.data.title || "Untitled"}`,
            "",
            "| Attachment | PDF | MD | TXT |",
            "|---|---:|---:|---:|",
          ];
          for (const attachment of attachments) {
            const files = resolveItemFiles(attachment.key, typeof attachment.data.path === "string" ? attachment.data.path : undefined);
            lines.push(`| [${attachment.key}] ${attachment.data.title || "Untitled"} | ${files.pdfPath ? "yes" : "no"} | ${files.mdPath ? "yes" : "no"} | ${files.txtPath ? "yes" : "no"} |`);
            if (files.pdfPath) lines.push(`| PDF path |  |  | ${files.pdfPath} |`);
            if (files.mdPath) lines.push(`| MD path |  |  | ${files.mdPath} |`);
            if (files.txtPath) lines.push(`| TXT path |  |  | ${files.txtPath} |`);
          }
          return ok(lines.join("\n"));
        }

        const attachment = selectAttachment(children, attachment_key);
        if (!attachment) return fail(new Error(`Item [${item_key}] has no attachments.`));
        const files = resolveItemFiles(attachment.key, typeof attachment.path === "string" ? attachment.path : undefined);

        if (action === "read") {
          const limit = max_chars ?? MAX_CHARS;
          let text: string | null = null;
          let usedSource = "";
          let usedPath = "";
          if ((source === "auto" || source === "md") && files.mdPath) {
            text = readFileSync(files.mdPath, "utf-8");
            usedSource = "md";
            usedPath = files.mdPath;
          }
          if (!text && (source === "auto" || source === "txt") && files.txtPath) {
            text = readFileSync(files.txtPath, "utf-8");
            usedSource = "txt";
            usedPath = files.txtPath;
          }
          if (!text && (source === "auto" || source === "index")) {
            const fulltext = await zot.getItemFulltext(attachment.key);
            if (fulltext?.content) {
              text = fulltext.content;
              usedSource = "index";
              usedPath = "Zotero fulltext index";
            }
          }
          if (!text) {
            return ok(
              `# ${item.data.title || "Untitled"}\n` +
                `**Item:** [${item_key}] | **Attachment:** [${attachment.key}]\n\n` +
                "No readable MD/TXT text file was found.\n\n" +
                `PDF: ${files.pdfPath || "not found"}\n` +
                `MD: ${files.mdPath || "not found"}\n` +
                `TXT: ${files.txtPath || "not found"}\n\n` +
                "Use `zotero_texts` with action=ocr, action=write, or action=import."
            );
          }
          const truncated = text.length > limit;
          const body = truncated ? text.slice(0, limit) : text;
          const header = [
            `# ${item.data.title || "Untitled"}`,
            `**Item:** [${item_key}] | **Attachment:** [${attachment.key}] | **Source:** ${usedSource}`,
            `**Path:** ${usedPath}`,
            `**Characters:** ${text.length.toLocaleString()}${truncated ? ` (truncated to ${limit.toLocaleString()})` : ""}`,
            "",
            "---",
            "",
          ].join("\n");
          return ok(header + body + (truncated ? "\n\n... [truncated]" : "") + "\n\n" + suggestNext("read_file"));
        }

        if (action === "write" || action === "import") {
          const sidecarFormat = format === "txt" ? "txt" : format === "md" ? "md" : undefined;
          if (!sidecarFormat) return fail(new Error("format must be md or txt for write/import actions"));
          const basePath = files.pdfPath || attachment.path;
          if (!basePath) return fail(new Error("Cannot determine the attachment storage path for this item."));
          const targetPath = join(dirname(basePath), fileNameFor(sidecarFormat, basePath, filename));
          if (action === "write") {
            if (content === undefined) return fail(new Error("content is required for write action"));
            writeFileSync(targetPath, content, "utf-8");
          } else {
            if (!source_path) return fail(new Error("source_path is required for import action"));
            if (!existsSync(source_path)) return fail(new Error(`File not found: ${source_path}`));
            copyFileSync(source_path, targetPath);
          }
          const size = statSync(targetPath).size;
          return ok(
            `${sidecarFormat.toUpperCase()} file saved for "${item.data.title || "Untitled"}"\n` +
              `**Item:** [${item_key}]\n` +
              `**Attachment:** [${attachment.key}]\n` +
              `**Path:** ${targetPath}\n` +
              `**Size:** ${(size / 1024).toFixed(1)} KB`
          );
        }

        const ocrFormat = (format ?? "md") as OcrFormat;
        if (!["md", "txt", "json"].includes(ocrFormat)) return fail(new Error("format must be md, txt, or json for ocr"));
        if (!files.pdfPath) return fail(new Error("PDF file not found on disk."));
        const result = await ocrPdf(files.pdfPath);
        const savePath = saveOcrResult(files.pdfPath, result, ocrFormat);
        const size = statSync(savePath).size;
        const lines = [
          `OCR processed: "${item.data.title || "Untitled"}"`,
          "",
          `**Item:** ${item.data.title || "Untitled"} [${item_key}]`,
          `**Attachment:** [${attachment.key}]`,
          `**Pages:** ${result.pages.length}`,
          `**Format:** ${ocrFormat}`,
          `**Saved:** ${savePath} (${(size / 1024).toFixed(1)} KB)`,
          `**Characters:** ${result.fullText.length.toLocaleString()}`,
        ];
        if (ocrFormat !== "txt") {
          const txtPath = saveOcrResult(files.pdfPath, result, "txt");
          const txtSize = statSync(txtPath).size;
          lines.push(`**TXT backup:** ${txtPath} (${(txtSize / 1024).toFixed(1)} KB)`);
        }
        if (save_images) {
          const imgPaths = await saveOcrImages(files.pdfPath, result);
          if (imgPaths.length) lines.push(`**Images saved:** ${imgPaths.length} files`);
        }
        lines.push("", "Next: call `zotero_item` to confirm MD/TXT availability, or `zotero_texts` action=read to read the text.");
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
