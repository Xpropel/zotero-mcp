import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import * as zot from "../zotero-client.js";
import { getCrossRefMeta, findOaPdf, downloadPdf, metaToZoteroPayload } from "../doi-import.js";
import { errorMessage } from "../utils.js";
import { ok, fail, suggestNext } from "../formatters.js";

export function registerImportTools(server: McpServer): void {
  server.tool(
    "zotero_import",
    "Import references into Zotero. Currently supports DOI metadata import with optional OA PDF attachment.",
    {
      doi: z.string().optional().describe("Single DOI to import"),
      dois: z.array(z.string()).optional().describe("Multiple DOIs to import"),
      collection_key: z.string().optional().describe("Collection key to add imported items to"),
      tags: z.array(z.string()).optional().describe("Tags to add to imported items"),
      download_pdf: z.boolean().default(true).describe("Attempt to download or link an OA PDF"),
    },
    async ({ doi, dois, collection_key, tags, download_pdf }) => {
      try {
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
