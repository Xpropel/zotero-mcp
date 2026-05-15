import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import * as zot from "../zotero-client.js";
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

function fileNameFor(format: "md" | "txt", pdfPath: string, filename?: string): string {
  if (filename) return filename;
  if (format === "txt") return suggestTxtFilename(pdfPath);
  return basename(pdfPath, extname(pdfPath)) + ".md";
}

export function registerFileTools(server: McpServer): void {
  server.tool(
    "zotero_read_file",
    "Read an item's saved text file for LLM analysis. This reads MD/TXT sidecar files or Zotero's text index; it does not parse PDF bytes directly.",
    {
      item_key: z.string().describe("Zotero item key"),
      attachment_key: z.string().optional().describe("Specific attachment key. Omit to use the best attachment."),
      source: z.enum(["auto", "md", "txt", "index"]).default("auto").describe("Text source: auto prefers MD, then TXT, then Zotero index"),
      max_chars: z.number().optional().describe("Max characters to return. Default 200000."),
    },
    async ({ item_key, attachment_key, source, max_chars }) => {
      try {
        const limit = max_chars ?? MAX_CHARS;
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);
        const att = selectAttachment(children, attachment_key);
        if (!att) return fail(new Error(`Item [${item_key}] has no attachments.`));

        const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);
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
          const ft = await zot.getItemFulltext(att.key);
          if (ft?.content) {
            text = ft.content;
            usedSource = "index";
            usedPath = "Zotero fulltext index";
          }
        }

        if (!text) {
          const available = [
            files.pdfPath ? `PDF: ${files.pdfPath}` : "PDF: not found",
            files.mdPath ? `MD: ${files.mdPath}` : "MD: not found",
            files.txtPath ? `TXT: ${files.txtPath}` : "TXT: not found",
          ].join("\n");
          return ok(
            `# ${item.data.title || "Untitled"}\n` +
              `**Item:** [${item_key}] | **Attachment:** [${att.key}]\n\n` +
              "No readable MD/TXT text file was found.\n\n" +
              `${available}\n\n` +
              "Use `zotero_ocr` to generate text from PDF, or `zotero_manage_files` to save/import an MD/TXT file."
          );
        }

        const truncated = text.length > limit;
        const content = truncated ? text.slice(0, limit) : text;
        const header = [
          `# ${item.data.title || "Untitled"}`,
          `**Item:** [${item_key}] | **Attachment:** [${att.key}] | **Source:** ${usedSource}`,
          `**Path:** ${usedPath}`,
          `**Characters:** ${text.length.toLocaleString()}${truncated ? ` (truncated to ${limit.toLocaleString()})` : ""}`,
          "",
          "---",
          "",
        ].join("\n");

        return ok(header + content + (truncated ? "\n\n... [truncated]" : "") + "\n\n" + suggestNext("read_file"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "zotero_manage_files",
    "List or add MD/TXT sidecar files for a Zotero item attachment. Use this to attach readable text representations after a PDF is imported.",
    {
      action: z.enum(["list", "write_text", "import_file"]).describe("Action to perform"),
      item_key: z.string().describe("Zotero item key"),
      attachment_key: z.string().optional().describe("Specific attachment key. Omit to use the best attachment."),
      format: z.enum(["md", "txt"]).optional().describe("Target sidecar format for write_text/import_file"),
      content: z.string().optional().describe("Text content for write_text"),
      source_path: z.string().optional().describe("Existing local .md/.txt file to copy into Zotero storage for import_file"),
      filename: z.string().optional().describe("Optional target filename. Defaults to the PDF basename with .md/.txt."),
    },
    async ({ action, item_key, attachment_key, format, content, source_path, filename }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);
        const att = selectAttachment(children, attachment_key);
        if (!att) return fail(new Error(`Item [${item_key}] has no attachments.`));

        const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);

        if (action === "list") {
          const lines = [
            `# File Inventory: ${item.data.title || "Untitled"}`,
            "",
            `**Item:** [${item_key}]`,
            `**Attachment:** [${att.key}] ${att.title}`,
            "",
            "| Type | Status | Path |",
            "|---|---:|---|",
            `| PDF | ${files.pdfPath ? "yes" : "no"} | ${files.pdfPath || ""} |`,
            `| MD | ${files.mdPath ? "yes" : "no"} | ${files.mdPath || ""} |`,
            `| TXT | ${files.txtPath ? "yes" : "no"} | ${files.txtPath || ""} |`,
          ];
          return ok(lines.join("\n"));
        }

        if (!format) return fail(new Error("format is required for write_text/import_file"));
        const basePath = files.pdfPath || att.path;
        if (!basePath) return fail(new Error("Cannot determine the attachment storage path for this item."));
        const targetName = fileNameFor(format, basePath, filename);
        const targetPath = join(dirname(basePath), targetName);

        if (action === "write_text") {
          if (content === undefined) return fail(new Error("content is required for write_text"));
          writeFileSync(targetPath, content, "utf-8");
        } else if (action === "import_file") {
          if (!source_path) return fail(new Error("source_path is required for import_file"));
          if (!existsSync(source_path)) return fail(new Error(`File not found: ${source_path}`));
          copyFileSync(source_path, targetPath);
        } else {
          return fail(new Error(`Unknown action: ${action}`));
        }

        const size = statSync(targetPath).size;
        return ok(
          `${format.toUpperCase()} file saved for "${item.data.title || "Untitled"}"\n` +
            `**Item:** [${item_key}]\n` +
            `**Attachment:** [${att.key}]\n` +
            `**Path:** ${targetPath}\n` +
            `**Size:** ${(size / 1024).toFixed(1)} KB`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
