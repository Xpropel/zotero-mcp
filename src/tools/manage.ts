import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { errorMessage } from "../utils.js";
import { ok, fail } from "../formatters.js";

export function registerManageTools(server: McpServer): void {
  // ── Generic item create ──
  server.tool(
    "zotero_create_item",
    "Create a Zotero item from explicit metadata. Requires the Zotero MCP Local Bridge plugin. " +
      "Use zotero_add for DOI-based import; use this for manual CRUD-style item creation.",
    {
      item_type: z
        .string()
        .default("journalArticle")
        .describe("Zotero item type, e.g. journalArticle, book, conferencePaper, thesis, report"),
      title: z.string().describe("Item title"),
      creators: z
        .array(z.object({
          creatorType: z.string().default("author"),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          name: z.string().optional(),
        }))
        .optional()
        .describe("Creators/authors/editors"),
      fields: z
        .record(z.any())
        .optional()
        .describe("Additional Zotero data fields, e.g. DOI, url, publicationTitle, date, abstractNote"),
      collection_keys: z.array(z.string()).optional().describe("Collection keys to add the item to"),
      tags: z.array(z.string()).optional().describe("Tags to set on the item"),
    },
    async ({ item_type, title, creators, fields, collection_keys, tags }) => {
      try {
        const payload: Record<string, unknown> = {
          ...(fields ?? {}),
          itemType: item_type,
          title,
        };
        if (creators?.length) payload.creators = creators;
        if (collection_keys?.length) payload.collections = collection_keys;
        if (tags?.length) payload.tags = tags.map((tag) => ({ tag }));

        const key = await zot.createItem(payload);
        return ok(
          `Item created: **${title}** [${key}]\n\n` +
            `Next: call \`zotero_item\` with item_key=\`${key}\` to verify it locally.`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

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
    "Create, rename, move, delete collections and add/remove items. Requires the Zotero MCP Local Bridge plugin.",
    {
      action: z
        .enum(["create", "rename", "move", "delete", "add_items", "remove_items"])
        .describe("Action to perform"),
      name: z.string().optional().describe("Collection name (for create action)"),
      parent_key: z.string().optional().describe("Parent collection key (for create/move, to nest under)"),
      collection_key: z.string().optional().describe("Target collection key (for add_items/remove_items)"),
      item_keys: z.array(z.string()).optional().describe("Item keys to add/remove"),
      confirm: z.boolean().default(false).describe("Required true for delete action"),
    },
    async ({ action, name, parent_key, collection_key, item_keys, confirm }) => {
      try {
        if (action === "create") {
          if (!name) return fail(new Error("name is required for create action"));
          const key = await zot.createCollection(name, parent_key);
          return ok(
            `Collection created: **${name}** [${key}]` +
              (parent_key ? ` (under ${parent_key})` : "")
          );
        }

        if (action === "rename") {
          if (!collection_key || !name) {
            return fail(new Error("collection_key and name are required for rename action"));
          }
          await zot.updateCollectionFields(collection_key, { name });
          return ok(`Renamed collection [${collection_key}] to **${name}**`);
        }

        if (action === "move") {
          if (!collection_key) return fail(new Error("collection_key is required for move action"));
          await zot.updateCollectionFields(collection_key, { parentCollection: parent_key || false });
          return ok(
            parent_key
              ? `Moved collection [${collection_key}] under [${parent_key}]`
              : `Moved collection [${collection_key}] to library root`
          );
        }

        if (action === "delete") {
          if (!collection_key) return fail(new Error("collection_key is required for delete action"));
          const collection = await zot.getCollection(collection_key);
          if (!confirm) {
            return ok(
              `Delete preview: collection **${collection.data.name}** [${collection_key}].\n` +
                "Run again with confirm=true to delete it."
            );
          }
          await zot.deleteCollection(collection_key);
          return ok(`Deleted collection **${collection.data.name}** [${collection_key}]`);
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

  // ── Item delete ──
  server.tool(
    "zotero_delete_items",
    "Delete Zotero items by key. Requires the Zotero MCP Local Bridge plugin. " +
      "Works for regular items, notes, and attachments because they are all Zotero items.",
    {
      item_keys: z.array(z.string()).min(1).describe("Item keys to delete"),
      confirm: z.boolean().default(false).describe("Required true to perform deletion"),
      permanent: z.boolean().default(false).describe("When true, permanently erase instead of moving to Zotero trash"),
    },
    async ({ item_keys, confirm, permanent }) => {
      try {
        const items = await Promise.all(item_keys.map((key) => zot.getItem(key)));
        if (!confirm) {
          const lines = [
            "# Delete Preview",
            "",
            "Run again with confirm=true to delete these items.",
            "",
          ];
          for (const item of items) {
            lines.push(`- [${item.key}] ${item.data.title || "Untitled"} (${item.data.itemType})`);
          }
          return ok(lines.join("\n"));
        }

        const deleted: string[] = [];
        const errors: string[] = [];
        for (const item of items) {
          try {
            await zot.deleteItem(item.key, permanent);
            deleted.push(`${item.key}: ${item.data.title || "Untitled"}`);
          } catch (e) {
            errors.push(`${item.key}: ${errorMessage(e)}`);
          }
        }

        const lines = [
          "# Delete Items",
          `- **Requested:** ${item_keys.length}`,
          `- **Deleted:** ${deleted.length}`,
        ];
        if (deleted.length) {
          lines.push("", "## Deleted");
          for (const item of deleted) lines.push(`- ${item}`);
        }
        if (errors.length) {
          lines.push("", "## Errors");
          for (const err of errors) lines.push(`- ${err}`);
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "zotero_move_items",
    "Copy or move items between Zotero collections. Requires the Zotero MCP Local Bridge plugin.",
    {
      item_keys: z.array(z.string()).min(1).describe("Item keys to copy or move"),
      target_collection_key: z.string().describe("Destination collection key"),
      source_collection_key: z.string().optional().describe("Source collection key; required for move mode"),
      mode: z.enum(["copy", "move"]).default("copy").describe("copy adds to target; move adds to target and removes from source"),
      confirm: z.boolean().default(false).describe("Required true to apply the change"),
    },
    async ({ item_keys, target_collection_key, source_collection_key, mode, confirm }) => {
      try {
        if (mode === "move" && !source_collection_key) {
          return fail(new Error("source_collection_key is required for move mode"));
        }

        const items = await Promise.all(item_keys.map((key) => zot.getItem(key)));
        const target = await zot.getCollection(target_collection_key);
        const source = source_collection_key ? await zot.getCollection(source_collection_key) : null;

        if (!confirm) {
          const lines = [
            "# Collection Transfer Preview",
            `- **Mode:** ${mode}`,
            `- **Target:** ${target.data.name} [${target_collection_key}]`,
            source ? `- **Source:** ${source.data.name} [${source_collection_key}]` : "",
            `- **Items:** ${items.length}`,
            "",
            "Run again with confirm=true to apply this change.",
            "",
            "## Items",
          ].filter(Boolean);
          for (const item of items) lines.push(`- [${item.key}] ${item.data.title || "Untitled"}`);
          return ok(lines.join("\n"));
        }

        await zot.addToCollection(target_collection_key, item_keys);
        if (mode === "move" && source_collection_key) {
          await zot.removeFromCollection(source_collection_key, item_keys);
        }

        return ok(
          `${mode === "move" ? "Moved" : "Copied"} ${item_keys.length} item(s) ` +
            `to **${target.data.name}** [${target_collection_key}]`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── Item metadata update ──
  server.tool(
    "zotero_update",
    "Update metadata fields of a Zotero item. Requires the Zotero MCP Local Bridge plugin.",
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
          `Item [${item_key}] updated locally: ${updated}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
