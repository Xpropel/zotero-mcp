import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import * as zot from "../zotero-client.js";
import { getCrossRefMeta, findOaPdf, downloadPdf, metaToZoteroPayload } from "../doi-import.js";
import { displayTitleFromFilePath, errorMessage } from "../utils.js";
import { ok, fail, suggestNext } from "../formatters.js";

function guessContentType(pathOrUrl: string, fallback = "application/octet-stream"): string {
  const ext = extname(pathOrUrl).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".md") return "text/markdown";
  if (ext === ".epub") return "application/epub+zip";
  return fallback;
}

export function registerImportTools(server: McpServer): void {
  server.tool(
    "zotero_import",
    "Import references into Zotero. Supports DOI metadata import and minimal local file import with optional attachment.",
    {
      doi: z.string().optional().describe("Single DOI to import"),
      dois: z.array(z.string()).optional().describe("Multiple DOIs to import"),
      file_path: z.string().optional().describe("Local file to import without metadata lookup"),
      title: z.string().optional().describe("Display title for local file import. Defaults to the file name without extension."),
      item_type: z.string().default("document").describe("Zotero item type for local file import"),
      content_type: z.string().optional().describe("MIME type for local file import; inferred when omitted"),
      collection_key: z.string().optional().describe("Collection key to add imported items to"),
      tags: z.array(z.string()).optional().describe("Tags to add to imported items"),
      download_pdf: z.boolean().default(true).describe("Attempt to download or link an OA PDF"),
    },
    async ({ doi, dois, file_path, title, item_type, content_type, collection_key, tags, download_pdf }) => {
      try {
        if (file_path) {
          if (!existsSync(file_path)) return fail(new Error(`File not found: ${file_path}`));
          if (!statSync(file_path).isFile()) return fail(new Error(`Not a file: ${file_path}`));
          const finalTitle = displayTitleFromFilePath(file_path, title);
          const payload: Record<string, unknown> = {
            itemType: item_type,
            title: finalTitle,
          };
          if (collection_key) payload.collections = [collection_key];
          if (tags?.length) payload.tags = tags.map((tag) => ({ tag }));
          const itemKey = await zot.createItem(payload);
          const attachmentKey = await zot.uploadAttachment(
            itemKey,
            file_path,
            content_type || guessContentType(file_path),
            finalTitle
          );
          return ok(
            "# Local File Import\n" +
              `- **Item:** ${finalTitle} [${itemKey}]\n` +
              `- **Attachment:** ${finalTitle} [${attachmentKey}]\n` +
              `- **File:** ${file_path}`
          );
        }

        const doiList = dois?.length ? dois : doi ? [doi] : [];
        if (!doiList.length) return fail(new Error("doi or dois is required"));
        const normalized = doiList.map((value) => value.match(/10\.\d{4,}\/[^\s]+/)?.[0] ?? value);
        const results: string[] = [];
        let successCount = 0;
        let pdfCount = 0;

        for (const value of normalized) {
          const lines: string[] = [];
          try {
            const meta = await getCrossRefMeta(value);
            const payload = metaToZoteroPayload(meta, collection_key);
            if (tags?.length) payload.tags = tags.map((tag) => ({ tag }));
            const itemKey = await zot.createItem(payload);
            successCount++;
            lines.push(`**${meta.title}**`);
            lines.push(`DOI: ${value} | ${meta.itemType} | ${meta.year || "n.d."}`);
            lines.push(`Zotero item created: [${itemKey}]`);

            if (download_pdf) {
              const pdfSource = await findOaPdf(value);
              if (!pdfSource) {
                lines.push("No OA PDF found");
              } else {
                const tmpDir = join("/tmp", "zotero-mcp-pdf");
                const filename = `${value.replace(/[/\\:]/g, "_")}.pdf`;
                const dl = await downloadPdf(pdfSource.url, tmpDir, filename);
                if (dl) {
                  try {
                    await zot.uploadAttachment(itemKey, dl.path, "application/pdf", filename);
                    lines.push(`PDF attached (${(dl.size / 1024).toFixed(0)} KB)`);
                    pdfCount++;
                  } catch {
                    await zot.createLinkedUrlAttachment(itemKey, pdfSource.url, `${meta.title}.pdf`);
                    lines.push("PDF linked as URL after upload failed");
                    pdfCount++;
                  }
                } else {
                  await zot.createLinkedUrlAttachment(itemKey, pdfSource.url, `${meta.title}.pdf`);
                  lines.push("PDF linked as URL");
                  pdfCount++;
                }
              }
            }
          } catch (e) {
            lines.push(`**Failed:** ${value} - ${errorMessage(e)}`);
          }
          results.push(lines.join("\n"));
        }

        const header = [
          "# Import Results",
          `- **Total:** ${normalized.length}`,
          `- **Items created:** ${successCount}`,
          `- **PDFs attached:** ${pdfCount}`,
          "",
        ].join("\n");
        return ok(header + results.join("\n\n") + "\n\n" + suggestNext("import"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
