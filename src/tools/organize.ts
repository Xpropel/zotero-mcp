import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { errorMessage } from "../utils.js";
import { ok, fail, fmtSearchList } from "../formatters.js";

export function registerOrganizeTools(server: McpServer): void {
  server.tool(
    "zotero_collections",
    "List all collections (as a tree) or get items within a specific collection. " +
      "Omit collection_key to see all collections; provide it to see items inside.",
    {
      collection_key: z.string().optional().describe("Collection key — if provided, lists items inside"),
      limit: z.number().default(50).describe("Max items (when listing collection contents)"),
    },
    async ({ collection_key, limit }) => {
      try {
        if (collection_key) {
          const [items, col] = await Promise.all([
            zot.getCollectionItems(collection_key, limit),
            zot.getCollection(collection_key),
          ]);
          return ok(fmtSearchList(items, `Collection: ${col.data.name}`));
        }

        const collections = await zot.getCollections();
        if (!collections.length) return ok("No collections found.");

        const map = new Map(collections.map((c) => [c.key, c]));
        const tree: Record<string, string[]> = {};
        for (const c of collections) {
          const pk = c.data.parentCollection || "__root__";
          (tree[pk] ??= []).push(c.key);
        }

        function render(key: string, lvl: number): string[] {
          const c = map.get(key);
          if (!c) return [];
          const count = c.meta?.numItems ?? 0;
          const out = [`${"  ".repeat(lvl)}- **${c.data.name}** [${key}] (${count} items)`];
          for (const ck of tree[key] ?? []) out.push(...render(ck, lvl + 1));
          return out;
        }

        const lines = ["# Zotero Collections", ""];
        const roots = tree["__root__"];
        if (roots?.length) {
          for (const k of roots) lines.push(...render(k, 0));
        } else {
          for (const c of collections) {
            lines.push(`- **${c.data.name}** [${c.key}] (${c.meta?.numItems ?? 0} items)`);
          }
        }
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_tags",
    "List all tags in the Zotero library, sorted by usage count.",
    {
      limit: z.number().optional().describe("Max tags to return"),
    },
    async ({ limit }) => {
      try {
        const tags = await zot.getTags(limit);
        if (!tags.length) return ok("No tags found.");
        const sorted = [...tags].sort((a, b) => (b.meta?.numItems ?? 0) - (a.meta?.numItems ?? 0));
        const lines = ["# Zotero Tags", ""];
        for (const t of sorted) lines.push(`- \`${t.tag}\` (${t.meta?.numItems ?? 0} items)`);
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_batch_tags",
    "Batch add or remove tags on items matching a search query. Requires Zotero Web API for writes; without it shows a preview.",
    {
      query: z.string().describe("Search query to find items"),
      add_tags: z.array(z.string()).optional().describe("Tags to add"),
      remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
      limit: z.number().default(50).describe("Max items to process"),
    },
    async ({ query, add_tags, remove_tags, limit }) => {
      try {
        if (!add_tags?.length && !remove_tags?.length) {
          return fail(new Error("Specify at least one of add_tags or remove_tags."));
        }

        const items = await zot.searchItems(query, { qmode: "titleCreatorYear", itemType: "-attachment", limit });
        if (!items.length) return ok(`No items found matching: ${query}`);

        if (zot.hasWebApi()) {
          let updated = 0;
          const errors: string[] = [];
          for (const item of items) {
            try {
              let tags = [...(item.data.tags ?? [])];
              let changed = false;
              if (add_tags) for (const t of add_tags) {
                if (!tags.some((x) => x.tag === t)) { tags.push({ tag: t }); changed = true; }
              }
              if (remove_tags) {
                const before = tags.length;
                tags = tags.filter((t) => !remove_tags.includes(t.tag));
                if (tags.length !== before) changed = true;
              }
              if (changed) { item.data.tags = tags; await zot.updateItem(item); updated++; }
            } catch (e) { errors.push(`${item.key}: ${errorMessage(e)}`); }
          }
          const lines = [
            `# Batch Tag Update`,
            `- **Query:** ${query}`,
            `- **Items found:** ${items.length}`,
            `- **Items updated:** ${updated}`,
          ];
          if (add_tags?.length) lines.push(`- **Tags added:** ${add_tags.join(", ")}`);
          if (remove_tags?.length) lines.push(`- **Tags removed:** ${remove_tags.join(", ")}`);
          if (errors.length) { lines.push("", "## Errors"); for (const e of errors) lines.push(`- ${e}`); }
          return ok(lines.join("\n"));
        }

        const lines = [
          `# Batch Tag Update (Preview — Web API required for writes)`,
          `- **Query:** ${query}`,
          `- **Items matched:** ${items.length}`,
        ];
        if (add_tags?.length) lines.push(`- **Tags to add:** ${add_tags.join(", ")}`);
        if (remove_tags?.length) lines.push(`- **Tags to remove:** ${remove_tags.join(", ")}`);
        lines.push("", "## Matched Items");
        for (const item of items) {
          const cur = (item.data.tags ?? []).map((t) => t.tag).join(", ") || "(none)";
          lines.push(`- ${item.data.title || "Untitled"} [${item.key}] — tags: ${cur}`);
        }
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );
}
