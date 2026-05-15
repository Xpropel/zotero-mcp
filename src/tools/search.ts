import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { ok, fail, fmtSearchList } from "../formatters.js";
import type { ZoteroItem } from "../types.js";

export function registerSearchTools(server: McpServer): void {
  server.tool(
    "zotero_search",
    "Search Zotero library with practical filters. Returns a concise list with available PDF/MD/TXT file indicators. " +
      "Use zotero_item for one item inventory and zotero_texts action=read to read saved MD/TXT text.",
    {
      query: z.string().optional().describe("Search keyword (omit to browse all / filter by other criteria)"),
      tag: z.array(z.string()).optional().describe("Filter by tags (OR logic: matches any)"),
      collection_key: z.string().optional().describe("Limit to a specific collection"),
      item_type: z
        .string()
        .optional()
        .describe("Filter by item type: journalArticle, book, conferencePaper, thesis, report, etc. Prefix with - to exclude (e.g. -attachment)"),
      year_from: z.number().optional().describe("Filter: published year >= this value"),
      year_to: z.number().optional().describe("Filter: published year <= this value"),
      sort: z
        .enum(["dateAdded", "dateModified", "title", "date"])
        .default("dateAdded")
        .describe("Sort field"),
      direction: z.enum(["desc", "asc"]).default("desc").describe("Sort direction"),
      limit: z.number().default(20).describe("Max results (1-100)"),
    },
    async ({ query, tag, collection_key, item_type, year_from, year_to, sort, direction, limit }) => {
      try {
        const effectiveLimit = Math.min(Math.max(limit, 1), 100);
        let items: ZoteroItem[];

        if (collection_key) {
          items = await zot.getCollectionItems(collection_key, effectiveLimit);
        } else if (query) {
          items = await zot.searchItems(query, {
            qmode: "everything",
            itemType: item_type || "-attachment",
            limit: effectiveLimit,
            tag,
            sort: sort === "date" ? "date" : sort,
            direction,
          });
        } else {
          items = await zot.getItems({
            limit: effectiveLimit,
            sort: sort === "date" ? "date" : sort,
            direction,
            itemType: item_type || "-attachment",
          });
        }

        // Client-side year filtering (Zotero API doesn't support year range natively)
        if (year_from || year_to) {
          items = items.filter((it) => {
            const dateStr = it.data.date || "";
            const yearMatch = dateStr.match(/(\d{4})/);
            if (!yearMatch) return false;
            const year = parseInt(yearMatch[1], 10);
            if (year_from && year < year_from) return false;
            if (year_to && year > year_to) return false;
            return true;
          });
        }

        // Client-side item type filtering for collection results
        if (collection_key && item_type) {
          const exclude = item_type.startsWith("-");
          const typeName = exclude ? item_type.slice(1) : item_type;
          items = items.filter((it) =>
            exclude ? it.data.itemType !== typeName : it.data.itemType === typeName
          );
        }

        const parts: string[] = [];
        if (query) parts.push(`"${query}"`);
        if (tag?.length) parts.push(`tags: ${tag.join(", ")}`);
        if (year_from || year_to) parts.push(`${year_from || "..."}–${year_to || "..."}`);
        if (item_type) parts.push(`type: ${item_type}`);
        const title = parts.length ? `Search: ${parts.join(" | ")}` : "Library Items";

        return ok(fmtSearchList(items, title));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
