import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, statSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import * as zot from "../zotero-client.js";
import { resolveItemFiles, resolveAttachmentPath, suggestTxtFilename } from "../utils.js";
import { ok, fail, fmtComprehensiveItem } from "../formatters.js";
import type { ZoteroItem, ZoteroAnnotationData } from "../types.js";

export function registerItemTools(server: McpServer): void {
  server.tool(
    "zotero_item",
    "Get comprehensive details for a Zotero item in ONE call: metadata, abstract, " +
      "PDF/TXT file paths, existing notes, and annotations. " +
      "If TXT exists, the full text is already available — read it directly instead of calling PaddleOCR. " +
      "If only PDF exists, get the PDF path and pass it to PaddleOCR, then use zotero_save_txt to cache the result.",
    {
      item_key: z.string().describe("Zotero item key (from zotero_search results)"),
    },
    async ({ item_key }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);

        // Resolve files (PDF + TXT detection)
        const att = zot.findBestAttachment(children);
        let pdfPath: string | undefined;
        let txtPath: string | undefined;
        let txtSize: number | undefined;
        let pdfFilename: string | undefined;

        if (att) {
          const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);
          pdfPath = files.pdfPath;
          txtPath = files.txtPath;
          txtSize = files.txtSize;
          pdfFilename = att.filename || undefined;
        }

        // Collect notes
        const notes = children.filter((c) => c.data.itemType === "note");

        // Collect annotations (BBT first, then API fallback)
        const annotationData: Array<ZoteroAnnotationData & { key?: string }> = [];
        const bbt = await zot.betterBibtexGetAnnotations(item_key);
        if (bbt?.length) {
          for (const a of bbt) annotationData.push(a as ZoteroAnnotationData);
        } else {
          let annots = children.filter((c) => c.data.itemType === "annotation");
          if (!annots.length) {
            const atts = children.filter((c) => c.data.itemType === "attachment");
            const nested = await Promise.all(atts.map((a) => zot.getItemChildren(a.key)));
            for (const ch of nested) annots.push(...ch.filter((c) => c.data.itemType === "annotation"));
          }
          for (const a of annots) annotationData.push({ ...a.data as ZoteroAnnotationData, key: a.key });
        }

        return ok(fmtComprehensiveItem(item, {
          pdfPath,
          txtPath,
          txtSize,
          pdfFilename,
          notes,
          annotations: annotationData,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_save_txt",
    "Save PaddleOCR-converted text alongside the PDF in Zotero storage. " +
      "Next time zotero_item is called, it will show the TXT as available — no need to re-run PaddleOCR.",
    {
      item_key: z.string().describe("Zotero item key"),
      content: z.string().describe("Full text content from PaddleOCR"),
      filename: z.string().optional().describe("Custom filename (default: derived from PDF name, e.g. paper.txt)"),
    },
    async ({ item_key, content, filename }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);
        const att = zot.findBestAttachment(children);

        if (!att) return fail(new Error("No attachment found for this item."));

        const rawPath = typeof att.path === "string" ? att.path : undefined;
        const files = resolveItemFiles(att.key, rawPath);

        if (!files.pdfPath) return fail(new Error("PDF file not found on disk."));

        const dir = dirname(files.pdfPath);
        const txtName = filename || suggestTxtFilename(files.pdfPath);
        const savePath = join(dir, txtName);

        writeFileSync(savePath, content, "utf-8");
        const size = statSync(savePath).size;

        const title = item.data.title || "Untitled";
        return ok(
          `TXT saved for "${title}"\n` +
          `**Path:** ${savePath}\n` +
          `**Size:** ${(size / 1024).toFixed(1)} KB\n` +
          `**Characters:** ${content.length.toLocaleString()}\n\n` +
          `Next time zotero_item is called for [${item_key}], this TXT will be shown as available.`
        );
      } catch (e) { return fail(e); }
    }
  );
}
