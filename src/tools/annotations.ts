import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { errorMessage } from "../utils.js";
import { ok, fail, fmtAnnotation } from "../formatters.js";
import type { ZoteroItem, ZoteroAnnotationData } from "../types.js";

export function registerAnnotationTools(server: McpServer): void {
  server.tool(
    "zotero_get_annotations",
    "Get annotations (highlights, notes) for a Zotero item.",
    {
      item_key: z.string().optional().describe("Item key (omit for all annotations)"),
      limit: z.number().default(50),
    },
    async ({ item_key, limit }) => {
      try {
        let annotations: ZoteroItem[] = [];

        if (item_key) {
          const bbt = await zot.betterBibtexGetAnnotations(item_key);
          if (bbt?.length) {
            const lines = [`# Annotations for ${item_key}`, ""];
            for (const a of bbt.slice(0, limit)) lines.push(...fmtAnnotation(a as ZoteroAnnotationData));
            return ok(lines.join("\n"));
          }

          const children = await zot.getItemChildren(item_key);
          annotations = children.filter((c) => c.data.itemType === "annotation");

          if (!annotations.length) {
            const atts = children.filter((c) => c.data.itemType === "attachment");
            const nested = await Promise.all(atts.map((a) => zot.getItemChildren(a.key)));
            for (const ch of nested) annotations.push(...ch.filter((c) => c.data.itemType === "annotation"));
          }
        } else {
          annotations = await zot.getItems({ limit, itemType: "annotation" });
        }

        const lines = [`# Annotations${item_key ? ` for ${item_key}` : ""}`, ""];
        for (const a of annotations.slice(0, limit)) {
          lines.push(...fmtAnnotation(a.data as ZoteroAnnotationData, a.key));
        }
        if (!annotations.length) lines.push("No annotations found.");
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_create_annotation",
    "Create a highlight annotation on a PDF or EPUB attachment. Requires Zotero Web API (ZOTERO_API_KEY) for write access. Note: position uses placeholder coordinates.",
    {
      attachment_key: z.string().describe("Attachment item key"),
      page: z.number().describe("Page number (1-based)"),
      text: z.string().describe("Text to highlight"),
      comment: z.string().optional().describe("Annotation comment"),
      color: z.string().default("#ffd400").describe("Highlight color"),
    },
    async ({ attachment_key, page, text, comment, color }) => {
      try {
        const key = await zot.createAnnotationItem(attachment_key, {
          annotationType: "highlight",
          annotationText: text,
          annotationComment: comment || "",
          annotationColor: color,
          annotationPageLabel: String(page),
          annotationSortIndex: `${String(page - 1).padStart(5, "0")}|000000|00000`,
          // Placeholder coordinates — Zotero will display the annotation but may not
          // highlight the exact text region without proper PDF coordinate extraction.
          annotationPosition: JSON.stringify({ pageIndex: page - 1, rects: [[0, 0, 100, 100]] }),
        });
        return ok(`Annotation created on page ${page} of attachment ${attachment_key}.\nAnnotation key: ${key}`);
      } catch (e) {
        if (errorMessage(e).includes("Web API")) {
          return ok(
            `# Cannot Create Annotation\n\nZotero Web API credentials are required.\n\n` +
            `**To enable:** Set ZOTERO_API_KEY, ZOTERO_LIBRARY_ID, ZOTERO_LIBRARY_TYPE.\n\n` +
            `**Annotation data:** attachment=${attachment_key}, page=${page}, text="${text}"` +
            (comment ? `, comment="${comment}"` : "") + `, color=${color}`
          );
        }
        return fail(e);
      }
    }
  );
}
