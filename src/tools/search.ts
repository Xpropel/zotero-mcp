import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { ok, fail, fmtSearchList } from "../formatters.js";

export function registerSearchTools(server: McpServer): void {
  server.tool(
    "zotero_search",
    "Search Zotero library. Returns a lean list with PDF/TXT availability indicators. " +
      "Use sort=dateAdded for recent items. Use zotero_item to get full details for a specific result.",
    {
      query: z.string().optional().describe("Search keyword (omit to browse all / filter by tag or collection)"),
      tag: z.array(z.string()).optional().describe("Filter by tags (OR logic: matches any)"),
      collection_key: z.string().optional().describe("Limit to a specific collection"),
      sort: z.enum(["dateAdded", "dateModified", "title"]).default("dateAdded").describe("Sort order"),
      limit: z.number().default(20).describe("Max results"),
    },
    async ({ query, tag, collection_key, sort, limit }) => {
      try {
        let items: Awaited<ReturnType<typeof zot.searchItems>>;

        if (collection_key) {
          items = await zot.getCollectionItems(collection_key, limit);
        } else if (query) {
          items = await zot.searchItems(query, {
            qmode: "everything",
            itemType: "-attachment",
            limit,
            tag,
            sort,
            direction: "desc",
          });
        } else {
          items = await zot.getItems({
            limit,
            sort,
            direction: "desc",
            itemType: "-attachment",
          });
        }

        const title = query
          ? `Search: "${query}"${tag?.length ? ` (tags: ${tag.join(", ")})` : ""}`
          : collection_key
            ? "Collection Items"
            : sort === "dateAdded"
              ? "Recent Items"
              : "Items";

        return ok(fmtSearchList(items, title));
      } catch (e) { return fail(e); }
    }
  );
}
