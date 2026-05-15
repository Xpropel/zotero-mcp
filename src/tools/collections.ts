import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { ok, fail, fmtSearchList } from "../formatters.js";

export function registerCollectionTools(server: McpServer): void {
  server.tool(
    "zotero_collections",
    "List, inspect, create, rename, move, delete, and transfer items between Zotero collections.",
    {
      action: z.enum(["list", "items", "create", "rename", "set_parent", "delete", "add_items", "remove_items", "transfer_items"]).default("list"),
      collection_key: z.string().optional().describe("Collection key for items/rename/move/delete/add/remove"),
      name: z.string().optional().describe("Collection name for create/rename"),
      parent_key: z.string().optional().describe("Parent collection key for create/set_parent"),
      item_keys: z.array(z.string()).optional().describe("Item keys for add/remove/transfer_items"),
      target_collection_key: z.string().optional().describe("Destination collection for transfer_items"),
      source_collection_key: z.string().optional().describe("Source collection for transfer_items in move mode"),
      mode: z.enum(["copy", "move"]).default("copy").describe("For transfer_items: copy or move"),
      limit: z.number().default(50).describe("Max items when listing collection contents"),
      confirm: z.boolean().default(false).describe("Required true for delete or transfer_items writes"),
    },
    async ({ action, collection_key, name, parent_key, item_keys, target_collection_key, source_collection_key, mode, limit, confirm }) => {
      try {
        if (action === "items") {
          if (!collection_key) return fail(new Error("collection_key is required for items action"));
          const [items, col] = await Promise.all([
            zot.getCollectionItems(collection_key, limit),
            zot.getCollection(collection_key),
          ]);
          return ok(fmtSearchList(items, `Collection: ${col.data.name}`));
        }

        if (action === "list") {
          const collections = await zot.getCollections();
          if (!collections.length) return ok("No collections found.");
          const map = new Map(collections.map((collection) => [collection.key, collection]));
          const tree: Record<string, string[]> = {};
          for (const collection of collections) {
            const pk = collection.data.parentCollection || "__root__";
            (tree[pk] ??= []).push(collection.key);
          }

          function render(key: string, lvl: number): string[] {
            const collection = map.get(key);
            if (!collection) return [];
            const count = collection.meta?.numItems ?? 0;
            const out = [`${"  ".repeat(lvl)}- **${collection.data.name}** [${key}] (${count} items)`];
            for (const childKey of tree[key] ?? []) out.push(...render(childKey, lvl + 1));
            return out;
          }

          const lines = ["# Zotero Collections", ""];
          const roots = tree.__root__;
          if (roots?.length) {
            for (const key of roots) lines.push(...render(key, 0));
          } else {
            for (const collection of collections) {
              lines.push(`- **${collection.data.name}** [${collection.key}] (${collection.meta?.numItems ?? 0} items)`);
            }
          }
          return ok(lines.join("\n"));
        }

        if (action === "create") {
          if (!name) return fail(new Error("name is required for create action"));
          const key = await zot.createCollection(name, parent_key);
          return ok(`Collection created: **${name}** [${key}]${parent_key ? ` (under ${parent_key})` : ""}`);
        }

        if (action === "rename") {
          if (!collection_key || !name) return fail(new Error("collection_key and name are required for rename action"));
          await zot.updateCollectionFields(collection_key, { name });
          return ok(`Renamed collection [${collection_key}] to **${name}**`);
        }

        if (action === "set_parent") {
          if (!collection_key) return fail(new Error("collection_key is required for set_parent action"));
          await zot.updateCollectionFields(collection_key, { parentCollection: parent_key || false });
          return ok(parent_key ? `Moved collection [${collection_key}] under [${parent_key}]` : `Moved collection [${collection_key}] to library root`);
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

        if (action === "add_items" || action === "remove_items") {
          if (!collection_key || !item_keys?.length) {
            return fail(new Error("collection_key and item_keys are required"));
          }
          if (action === "add_items") {
            await zot.addToCollection(collection_key, item_keys);
            return ok(`Added ${item_keys.length} item(s) to collection [${collection_key}]`);
          }
          await zot.removeFromCollection(collection_key, item_keys);
          return ok(`Removed ${item_keys.length} item(s) from collection [${collection_key}]`);
        }

        if (!item_keys?.length || !target_collection_key) {
          return fail(new Error("item_keys and target_collection_key are required for transfer_items action"));
        }
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
        return ok(`${mode === "move" ? "Moved" : "Copied"} ${item_keys.length} item(s) to **${target.data.name}** [${target_collection_key}]`);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
