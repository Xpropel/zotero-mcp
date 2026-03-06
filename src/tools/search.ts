import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { ok, fail, fmtList } from "../formatters.js";

export function registerSearchTools(server: McpServer): void {
  server.tool(
    "zotero_search_items",
    "Search for items in your Zotero library. Supports keyword search, tag filtering, or both combined.",
    {
      query: z.string().default("").describe("Search keyword (empty string to browse/filter by tag only)"),
      qmode: z.enum(["titleCreatorYear", "everything"]).default("titleCreatorYear").describe("Query mode"),
      item_type: z.string().default("-attachment").describe("Item type filter"),
      limit: z.number().default(10).describe("Max results"),
      tag: z.array(z.string()).optional().describe("Tag filters"),
    },
    async ({ query, qmode, item_type, limit, tag }) => {
      try {
        const items = await zot.searchItems(query, { qmode, itemType: item_type, limit, tag });
        const title = tag?.length
          ? `Search Results for '${query}' (tags: ${tag.join(", ")})`
          : `Search Results for '${query}'`;
        return ok(fmtList(items, title));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_recent",
    "Get recently added items.",
    { limit: z.number().default(10).describe("Max results") },
    async ({ limit }) => {
      try {
        const items = await zot.getItems({ limit, sort: "dateAdded", direction: "desc", itemType: "-attachment" });
        return ok(fmtList(items, "Recently Added Items"));
      } catch (e) { return fail(e); }
    }
  );
}
