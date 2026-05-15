import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { resolveItemFiles } from "../utils.js";
import { ok, fail, fmtComprehensiveItem } from "../formatters.js";
import type { ZoteroAnnotationData, FileInventoryEntry } from "../types.js";

export function registerItemTools(server: McpServer): void {
  server.tool(
    "zotero_item",
    "Get one Zotero item's metadata and local file inventory in one call: PDF/MD/TXT availability, attachment keys, notes, and annotations.",
    {
      item_key: z.string().describe("Zotero item key (from zotero_search results)"),
    },
    async ({ item_key }) => {
      try {
        const item = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);

        const attachments = children.filter((c) => c.data.itemType === "attachment");
        const fileInventory: FileInventoryEntry[] = [];
        for (const att of attachments) {
          const files = resolveItemFiles(att.key, typeof att.data.path === "string" ? att.data.path : undefined);
          fileInventory.push({
            attachmentKey: att.key,
            title: att.data.title || "Untitled",
            filename: att.data.filename || "",
            contentType: att.data.contentType || "",
            files,
          });
        }

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
          fileInventory,
          notes,
          annotations: annotationData,
        }));
      } catch (e) { return fail(e); }
    }
  );
}
