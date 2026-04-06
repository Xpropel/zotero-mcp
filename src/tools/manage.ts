import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { errorMessage } from "../utils.js";
import { ok, fail } from "../formatters.js";

export function registerManageTools(server: McpServer): void {
  // ── Duplicate detection ──
  server.tool(
    "zotero_duplicates",
    "Find duplicate items in your library by matching DOI or similar titles. " +
      "Returns groups of potential duplicates for review.",
    {
      scope: z
        .enum(["all", "collection", "recent"])
        .default("recent")
        .describe("Scope: all (entire library), collection (specific), or recent (last 100 added)"),
      collection_key: z.string().optional().describe("Collection key (when scope=collection)"),
      limit: z.number().default(100).describe("Max items to scan"),
    },
    async ({ scope, collection_key, limit }) => {
      try {
        let items: Awaited<ReturnType<typeof zot.getItems>>;

        if (scope === "collection" && collection_key) {
          items = await zot.getCollectionItems(collection_key, limit);
        } else if (scope === "all") {
          items = await zot.getItems({ limit, sort: "dateAdded", direction: "desc", itemType: "-attachment" });
        } else {
          items = await zot.getItems({ limit: Math.min(limit, 100), sort: "dateAdded", direction: "desc", itemType: "-attachment" });
        }

        // Build DOI index and title index
        const doiGroups = new Map<string, typeof items>();
        const titleGroups = new Map<string, typeof items>();

        for (const item of items) {
          if (item.data.itemType === "note" || item.data.itemType === "attachment") continue;

          // DOI matching (exact)
          const doi = item.data.DOI?.toLowerCase().trim();
          if (doi) {
            const group = doiGroups.get(doi) ?? [];
            group.push(item);
            doiGroups.set(doi, group);
          }

          // Title matching (normalized)
          const title = (item.data.title || "")
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
            .trim();
          if (title.length > 10) {
            const group = titleGroups.get(title) ?? [];
            group.push(item);
            titleGroups.set(title, group);
          }
        }

        // Collect duplicates
        const dupSets: Array<{ reason: string; items: typeof items }> = [];
        const seen = new Set<string>();

        for (const [doi, group] of doiGroups) {
          if (group.length < 2) continue;
          const keys = group.map((i) => i.key).sort().join(",");
          if (seen.has(keys)) continue;
          seen.add(keys);
          dupSets.push({ reason: `DOI: ${doi}`, items: group });
        }

        for (const [title, group] of titleGroups) {
          if (group.length < 2) continue;
          const keys = group.map((i) => i.key).sort().join(",");
          if (seen.has(keys)) continue;
          seen.add(keys);
          dupSets.push({ reason: `Title match`, items: group });
        }

        if (!dupSets.length) {
          return ok(`# Duplicate Check\nScanned ${items.length} items — no duplicates found.`);
        }

        const lines = [
          `# Duplicate Check`,
          `Scanned ${items.length} items — found ${dupSets.length} duplicate group(s)`,
          "",
        ];

        for (let i = 0; i < dupSets.length; i++) {
          const ds = dupSets[i];
          lines.push(`## Group ${i + 1} (${ds.reason})`);
          for (const it of ds.items) {
            const date = it.data.date || "n.d.";
            lines.push(`- [${it.key}] ${it.data.title || "Untitled"} (${date}) — ${it.data.itemType}`);
          }
          lines.push("");
        }

        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Collection management ──
  server.tool(
    "zotero_manage_collections",
    "Create collections and add/remove items from collections. Requires Zotero Web API.",
    {
      action: z
        .enum(["create", "add_items", "remove_items"])
        .describe("Action to perform"),
      name: z.string().optional().describe("Collection name (for create action)"),
      parent_key: z.string().optional().describe("Parent collection key (for create, to nest under)"),
      collection_key: z.string().optional().describe("Target collection key (for add_items/remove_items)"),
      item_keys: z.array(z.string()).optional().describe("Item keys to add/remove"),
    },
    async ({ action, name, parent_key, collection_key, item_keys }) => {
      try {
        if (action === "create") {
          if (!name) return fail(new Error("name is required for create action"));
          const key = await zot.createCollection(name, parent_key);
          return ok(
            `Collection created: **${name}** [${key}]` +
              (parent_key ? ` (under ${parent_key})` : "")
          );
        }

        if (action === "add_items") {
          if (!collection_key || !item_keys?.length) {
            return fail(new Error("collection_key and item_keys are required"));
          }
          await zot.addToCollection(collection_key, item_keys);
          return ok(`Added ${item_keys.length} item(s) to collection [${collection_key}]`);
        }

        if (action === "remove_items") {
          if (!collection_key || !item_keys?.length) {
            return fail(new Error("collection_key and item_keys are required"));
          }
          await zot.removeFromCollection(collection_key, item_keys);
          return ok(`Removed ${item_keys.length} item(s) from collection [${collection_key}]`);
        }

        return fail(new Error(`Unknown action: ${action}`));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Item metadata update ──
  server.tool(
    "zotero_update",
    "Update metadata fields of a Zotero item. Requires Zotero Web API. " +
      "After update, sync Zotero desktop to see changes locally.",
    {
      item_key: z.string().describe("Item key to update"),
      title: z.string().optional().describe("New title"),
      date: z.string().optional().describe("New date (e.g. 2024-01-15)"),
      abstract: z.string().optional().describe("New abstract"),
      doi: z.string().optional().describe("New DOI"),
      url: z.string().optional().describe("New URL"),
      journal: z.string().optional().describe("New journal/publication title"),
      volume: z.string().optional().describe("New volume"),
      issue: z.string().optional().describe("New issue"),
      pages: z.string().optional().describe("New pages"),
      tags: z.array(z.string()).optional().describe("Replace all tags (use zotero_batch_tags for add/remove)"),
      extra: z.string().optional().describe("Extra field content"),
    },
    async ({ item_key, title, date, abstract: abstractNote, doi, url, journal, volume, issue, pages, tags, extra }) => {
      try {
        const fields: Record<string, unknown> = {};
        if (title !== undefined) fields.title = title;
        if (date !== undefined) fields.date = date;
        if (abstractNote !== undefined) fields.abstractNote = abstractNote;
        if (doi !== undefined) fields.DOI = doi;
        if (url !== undefined) fields.url = url;
        if (journal !== undefined) fields.publicationTitle = journal;
        if (volume !== undefined) fields.volume = volume;
        if (issue !== undefined) fields.issue = issue;
        if (pages !== undefined) fields.pages = pages;
        if (extra !== undefined) fields.extra = extra;
        if (tags !== undefined) fields.tags = tags.map((t) => ({ tag: t }));

        if (!Object.keys(fields).length) {
          return fail(new Error("No fields to update. Provide at least one field."));
        }

        await zot.updateItemFields(item_key, fields);

        const updated = Object.keys(fields).join(", ");
        return ok(
          `Item [${item_key}] updated: ${updated}\n\n` +
            "请在 Zotero 中同步以查看本地更新。"
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
