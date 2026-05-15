import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import * as zot from "../zotero-client.js";
import { resolveItemFiles, suggestTxtFilename } from "../utils.js";
import { ocrPdf, saveOcrImages, saveOcrResult } from "../paddle-ocr.js";
import type { OcrFormat } from "../paddle-ocr.js";
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

function fileNameFor(format: "md" | "txt", pdfPath: string, filename?: string): string {
  if (filename) return filename;
  if (format === "txt") return suggestTxtFilename(pdfPath);
  return basename(pdfPath, extname(pdfPath)) + ".md";
}

function guessContentType(pathOrUrl: string, fallback = "application/octet-stream"): string {
  const ext = extname(pathOrUrl).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".md") return "text/markdown";
  if (ext === ".epub") return "application/epub+zip";
  return fallback;
}

export function registerFileTools(server: McpServer): void {
  server.tool(
    "zotero_files",
    "Manage a Zotero item's files and attachments: list inventory, read MD/TXT/index text, write/import sidecars, import/link/update/delete attachments, or OCR a PDF.",
    {
      action: z.enum([
        "list",
        "read",
        "write_text",
        "import_sidecar",
        "import_attachment",
        "link_attachment",
        "link_url",
        "update_attachment",
        "delete_attachment",
        "ocr",
      ]).describe("Action to perform"),
      item_key: z.string().optional().describe("Parent Zotero item key for item-file actions"),
      attachment_key: z.string().optional().describe("Specific attachment key. Omit to use the best attachment."),
      source: z.enum(["auto", "md", "txt", "index"]).default("auto").describe("For read: text source"),
      max_chars: z.number().optional().describe("For read: max characters to return. Default 200000."),
      format: z.enum(["md", "txt", "json"]).optional().describe("For sidecar/OCR actions: target format"),
      content: z.string().optional().describe("For write_text: text content"),
      source_path: z.string().optional().describe("For import_sidecar: existing .md/.txt path to copy"),
      file_path: z.string().optional().describe("For import_attachment/link_attachment: local file path"),
      filename: z.string().optional().describe("Optional target sidecar filename"),
      url: z.string().optional().describe("For link_url: URL to attach"),
      title: z.string().optional().describe("Attachment title"),
      content_type: z.string().optional().describe("MIME type; inferred for common file extensions when omitted"),
      tags: z.array(z.string()).optional().describe("For update_attachment: replace attachment tags"),
      save_images: z.boolean().default(false).describe("For OCR: save extracted images when supported"),
      confirm: z.boolean().default(false).describe("Required true for delete_attachment"),
      permanent: z.boolean().default(false).describe("For delete_attachment: permanently erase instead of moving to trash"),
    },
    async (args) => {
      try {
        if (args.action === "import_attachment" || args.action === "link_attachment") {
          if (!args.item_key) return fail(new Error("item_key is required for attachment file actions"));
          if (!args.file_path) return fail(new Error("file_path is required for attachment file actions"));
          if (!existsSync(args.file_path)) return fail(new Error(`File not found: ${args.file_path}`));
          if (!statSync(args.file_path).isFile()) return fail(new Error(`Not a file: ${args.file_path}`));
          const finalTitle = args.title || basename(args.file_path);
          const finalContentType = args.content_type || guessContentType(args.file_path);
          const key = args.action === "import_attachment"
            ? await zot.uploadAttachment(args.item_key, args.file_path, finalContentType, finalTitle)
            : await zot.linkLocalFileAttachment(args.item_key, args.file_path, finalContentType, finalTitle);
          return ok(
            `${args.action === "import_attachment" ? "Imported" : "Linked"} attachment **${finalTitle}** [${key}] ` +
              `for item [${args.item_key}]`
          );
        }

        if (args.action === "link_url") {
          if (!args.item_key) return fail(new Error("item_key is required for link_url action"));
          if (!args.url) return fail(new Error("url is required for link_url action"));
          const finalTitle = args.title || args.url;
          const key = await zot.createLinkedUrlAttachment(
            args.item_key,
            args.url,
            finalTitle,
            args.content_type || guessContentType(args.url, "application/pdf")
          );
          return ok(`Linked URL attachment **${finalTitle}** [${key}] for item [${args.item_key}]`);
        }

        if (args.action === "update_attachment") {
          if (!args.attachment_key) return fail(new Error("attachment_key is required for update_attachment action"));
          if (args.title === undefined && args.tags === undefined) {
            return fail(new Error("Provide title or tags for update_attachment action"));
          }
          await zot.updateAttachmentFields(args.attachment_key, { title: args.title, tags: args.tags });
          const changed = [
            args.title !== undefined ? "title" : "",
            args.tags !== undefined ? "tags" : "",
          ].filter(Boolean).join(", ");
          return ok(`Attachment [${args.attachment_key}] updated locally: ${changed}`);
        }

        if (args.action === "delete_attachment") {
          if (!args.attachment_key) return fail(new Error("attachment_key is required for delete_attachment action"));
          const attachment = await zot.getItem(args.attachment_key);
          if (!args.confirm) {
            return ok(
              `Delete preview: attachment **${attachment.data.title || "Untitled"}** [${args.attachment_key}].\n` +
                "Run again with confirm=true to delete it."
            );
          }
          await zot.deleteItem(args.attachment_key, args.permanent);
          return ok(`Deleted attachment **${attachment.data.title || "Untitled"}** [${args.attachment_key}]`);
        }

        if (!args.item_key) return fail(new Error("item_key is required for this file action"));
        const item = await zot.getItem(args.item_key);
        const children = await zot.getItemChildren(args.item_key);

        if (args.action === "list") {
          const attachments = children.filter((child) =>
            child.data.itemType === "attachment" && (!args.attachment_key || child.key === args.attachment_key)
          );
          if (!attachments.length) return ok(`No attachments found for item [${args.item_key}].`);
          const lines = [
            `# File Inventory: ${item.data.title || "Untitled"}`,
            "",
            `**Item:** [${args.item_key}]`,
            "",
            "| Attachment | Content type | PDF | MD | TXT | Path |",
            "|---|---|---:|---:|---:|---|",
          ];
          for (const attachment of attachments) {
            const files = resolveItemFiles(attachment.key, typeof attachment.data.path === "string" ? attachment.data.path : undefined);
            lines.push(
              `| [${attachment.key}] ${attachment.data.title || "Untitled"} | ${attachment.data.contentType || ""} | ` +
                `${files.pdfPath ? "yes" : "no"} | ${files.mdPath ? "yes" : "no"} | ${files.txtPath ? "yes" : "no"} | ` +
                `${files.pdfPath || files.mdPath || files.txtPath || ""} |`
            );
          }
          return ok(lines.join("\n"));
        }

        const att = selectAttachment(children, args.attachment_key);
        if (!att) return fail(new Error(`Item [${args.item_key}] has no attachments.`));
        const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);

        if (args.action === "read") {
          const limit = args.max_chars ?? MAX_CHARS;
          let text: string | null = null;
          let usedSource = "";
          let usedPath = "";
          if ((args.source === "auto" || args.source === "md") && files.mdPath) {
            text = readFileSync(files.mdPath, "utf-8");
            usedSource = "md";
            usedPath = files.mdPath;
          }
          if (!text && (args.source === "auto" || args.source === "txt") && files.txtPath) {
            text = readFileSync(files.txtPath, "utf-8");
            usedSource = "txt";
            usedPath = files.txtPath;
          }
          if (!text && (args.source === "auto" || args.source === "index")) {
            const fulltext = await zot.getItemFulltext(att.key);
            if (fulltext?.content) {
              text = fulltext.content;
              usedSource = "index";
              usedPath = "Zotero fulltext index";
            }
          }
          if (!text) {
            return ok(
              `# ${item.data.title || "Untitled"}\n` +
                `**Item:** [${args.item_key}] | **Attachment:** [${att.key}]\n\n` +
                "No readable MD/TXT text file was found.\n\n" +
                `PDF: ${files.pdfPath || "not found"}\n` +
                `MD: ${files.mdPath || "not found"}\n` +
                `TXT: ${files.txtPath || "not found"}\n\n` +
                "Use `zotero_files` with action=ocr, action=write_text, or action=import_sidecar."
            );
          }
          const truncated = text.length > limit;
          const content = truncated ? text.slice(0, limit) : text;
          const header = [
            `# ${item.data.title || "Untitled"}`,
            `**Item:** [${args.item_key}] | **Attachment:** [${att.key}] | **Source:** ${usedSource}`,
            `**Path:** ${usedPath}`,
            `**Characters:** ${text.length.toLocaleString()}${truncated ? ` (truncated to ${limit.toLocaleString()})` : ""}`,
            "",
            "---",
            "",
          ].join("\n");
          return ok(header + content + (truncated ? "\n\n... [truncated]" : "") + "\n\n" + suggestNext("read_file"));
        }

        if (args.action === "write_text" || args.action === "import_sidecar") {
          const format = args.format === "txt" ? "txt" : args.format === "md" ? "md" : undefined;
          if (!format) return fail(new Error("format must be md or txt for sidecar actions"));
          const basePath = files.pdfPath || att.path;
          if (!basePath) return fail(new Error("Cannot determine the attachment storage path for this item."));
          const targetName = fileNameFor(format, basePath, args.filename);
          const targetPath = join(dirname(basePath), targetName);
          if (args.action === "write_text") {
            if (args.content === undefined) return fail(new Error("content is required for write_text"));
            writeFileSync(targetPath, args.content, "utf-8");
          } else {
            if (!args.source_path) return fail(new Error("source_path is required for import_sidecar"));
            if (!existsSync(args.source_path)) return fail(new Error(`File not found: ${args.source_path}`));
            copyFileSync(args.source_path, targetPath);
          }
          const size = statSync(targetPath).size;
          return ok(
            `${format.toUpperCase()} file saved for "${item.data.title || "Untitled"}"\n` +
              `**Item:** [${args.item_key}]\n` +
              `**Attachment:** [${att.key}]\n` +
              `**Path:** ${targetPath}\n` +
              `**Size:** ${(size / 1024).toFixed(1)} KB`
          );
        }

        const format = (args.format ?? "md") as OcrFormat;
        if (!["md", "txt", "json"].includes(format)) return fail(new Error("format must be md, txt, or json for ocr"));
        if (!files.pdfPath) return fail(new Error("PDF file not found on disk."));
        const result = await ocrPdf(files.pdfPath);
        const savePath = saveOcrResult(files.pdfPath, result, format);
        const size = statSync(savePath).size;
        const lines = [
          `OCR processed: "${item.data.title || "Untitled"}"`,
          "",
          `**Item:** ${item.data.title || "Untitled"} [${args.item_key}]`,
          `**Attachment:** [${att.key}]`,
          `**Pages:** ${result.pages.length}`,
          `**Format:** ${format}`,
          `**Saved:** ${savePath} (${(size / 1024).toFixed(1)} KB)`,
          `**Characters:** ${result.fullText.length.toLocaleString()}`,
        ];
        if (format !== "txt") {
          const txtPath = saveOcrResult(files.pdfPath, result, "txt");
          const txtSize = statSync(txtPath).size;
          lines.push(`**TXT backup:** ${txtPath} (${(txtSize / 1024).toFixed(1)} KB)`);
        }
        if (args.save_images) {
          const imgPaths = await saveOcrImages(files.pdfPath, result);
          if (imgPaths.length) lines.push(`**Images saved:** ${imgPaths.length} files`);
        }
        lines.push("", "Next: call `zotero_item` to confirm MD/TXT availability, or `zotero_files` action=read to read the text.");
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
