import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, statSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import * as zot from "../zotero-client.js";
import { resolveItemFiles, suggestTxtFilename } from "../utils.js";
import { ok, fail, fmtComprehensiveItem } from "../formatters.js";
import type { ZoteroAnnotationData } from "../types.js";

export function registerItemTools(server: McpServer): void {
  server.tool(
    "zotero_item",
    "Get comprehensive details for a Zotero item in ONE call: metadata, abstract, " +
      "PDF/TXT/MD file paths, existing notes, and annotations. " +
      "If MD exists, prefer reading it (preserves structure). " +
      "If only TXT exists, read it directly. " +
      "If only PDF exists, use zotero_ocr to convert, then read the result.",
    {
      item_key: z.string().describe("Zotero item key (from zotero_search results)"),
    },
    async ({ item_key }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);

        // Resolve files (PDF + TXT + MD detection)
        const att = zot.findBestAttachment(children);
        let pdfPath: string | undefined;
        let txtPath: string | undefined;
        let txtSize: number | undefined;
        let mdPath: string | undefined;
        let mdSize: number | undefined;
        let pdfFilename: string | undefined;

        if (att) {
          const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);
          pdfPath = files.pdfPath;
          txtPath = files.txtPath;
          txtSize = files.txtSize;
          mdPath = files.mdPath;
          mdSize = files.mdSize;
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
          mdPath,
          mdSize,
          pdfFilename,
          notes,
          annotations: annotationData,
        }));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_save_txt",
    "Save text content alongside the PDF in Zotero storage. " +
      "Typically used after PaddleOCR conversion. Prefer zotero_ocr which does this automatically.",
    {
      item_key: z.string().describe("Zotero item key"),
      content: z.string().describe("Full text content"),
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
