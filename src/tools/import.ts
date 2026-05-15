import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import * as zot from "../zotero-client.js";
import { getStorageDir } from "../utils.js";
import { getCrossRefMeta, findOaPdf, downloadPdf, metaToZoteroPayload } from "../doi-import.js";
import { ok, fail, suggestNext } from "../formatters.js";

export function registerImportTools(server: McpServer): void {
  server.tool(
    "zotero_add",
      "Import a paper into Zotero by DOI. Fetches metadata from CrossRef and attempts to download the OA PDF " +
      "(Unpaywall → Semantic Scholar → PubMed Central → CrossRef). " +
      "Also supports batch import with multiple DOIs. " +
      "Requires the Zotero MCP Local Bridge plugin for Zotero writes.",
    {
      doi: z.string().optional().describe("Single DOI to import (e.g. 10.1234/example)"),
      dois: z.array(z.string()).optional().describe("Batch import: array of DOIs"),
      collection: z.string().optional().describe("Collection key to add the item to"),
      download_pdf: z.boolean().default(true).describe("Attempt to download OA PDF"),
      tags: z.array(z.string()).optional().describe("Tags to add to imported items"),
    },
    async ({ doi, dois, collection, download_pdf, tags }) => {
      try {
        const doiList = dois?.length ? dois : doi ? [doi] : [];
        if (!doiList.length) return fail(new Error("Provide doi or dois parameter"));

        // Normalize DOIs
        const normalized = doiList.map((d) => {
          const m = d.match(/10\.\d{4,}\/[^\s]+/);
          return m ? m[0] : d;
        });

        const results: string[] = [];
        let successCount = 0;
        let pdfCount = 0;

        for (const d of normalized) {
          const lines: string[] = [];
          try {
            // 1. Fetch metadata
            const meta = await getCrossRefMeta(d);
            lines.push(`**${meta.title}**`);
            lines.push(`DOI: ${d} | ${meta.itemType} | ${meta.year || "n.d."}`);

            // 2. Create Zotero item via the local bridge
            const payload = metaToZoteroPayload(meta, collection);
            if (tags?.length) {
              payload.tags = tags.map((t) => ({ tag: t }));
            }
            const itemKey = await zot.createItem(payload);
            lines.push(`Zotero item created: [${itemKey}]`);
            successCount++;

            // 3. Try download OA PDF
            if (download_pdf) {
              const pdfSource = await findOaPdf(d);
              if (pdfSource) {
                lines.push(`OA PDF found (${pdfSource.source}): ${pdfSource.url.slice(0, 80)}`);

                // Download to temp, then attach via the local bridge
                const tmpDir = join("/tmp", "zotero-mcp-pdf");
                const filename = `${d.replace(/[/\\:]/g, "_")}.pdf`;
                const dl = await downloadPdf(pdfSource.url, tmpDir, filename);
                if (dl) {
                  // Upload PDF as attachment
                  try {
                    await zot.uploadAttachment(itemKey, dl.path, "application/pdf", filename);
                    lines.push(`PDF attached (${(dl.size / 1024).toFixed(0)} KB)`);
                    pdfCount++;
                  } catch (e) {
                    // Fallback: create linked URL attachment
                    try {
                      await zot.createLinkedUrlAttachment(itemKey, pdfSource.url, `${meta.title}.pdf`);
                      lines.push(`PDF linked (upload failed, saved as URL)`);
                      pdfCount++;
                    } catch {
                      lines.push(`PDF download OK but attach failed`);
                    }
                  }
                } else {
                  // Download failed (likely CDN block), save as linked URL
                  try {
                    await zot.createLinkedUrlAttachment(itemKey, pdfSource.url, `${meta.title}.pdf`);
                    lines.push(`PDF linked as URL (download blocked by CDN)`);
                    pdfCount++;
                  } catch {
                    lines.push(`PDF found but could not attach`);
                  }
                }
              } else {
                lines.push(`No OA PDF found`);
              }
            }
          } catch (e) {
            lines.push(`**Failed:** ${d} — ${e instanceof Error ? e.message : e}`);
          }
          results.push(lines.join("\n"));
        }

        const header = [
          `# Import Results`,
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
