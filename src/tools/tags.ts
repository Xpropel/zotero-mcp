import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { errorMessage } from "../utils.js";
import { ok, fail } from "../formatters.js";
import type { ZoteroItem } from "../types.js";

async function tagTargetItems(itemKeys?: string[], query?: string, limit = 500): Promise<ZoteroItem[]> {
  if (itemKeys?.length) return Promise.all(itemKeys.map((key) => zot.getItem(key)));
  if (query) return zot.searchItems(query, { qmode: "titleCreatorYear", itemType: "-attachment", limit });
  throw new Error("item_keys or query is required");
}

export function registerTagTools(server: McpServer): void {
  server.tool(
    "zotero_tags",
    "List tags, update tags on explicit items, or rename/merge/delete a tag across local Zotero items.",
    {
      action: z.enum(["list", "update_items", "rename", "merge", "delete"]).default("list").describe("Action to perform"),
      item_keys: z.array(z.string()).optional().describe("For update_items: explicit item keys to update"),
      query: z.string().optional().describe("For update_items: search query to find target items when item_keys is omitted"),
      add_tags: z.array(z.string()).optional().describe("For update_items: tags to add"),
      remove_tags: z.array(z.string()).optional().describe("For update_items: tags to remove"),
      old_tag: z.string().optional().describe("For rename/merge/delete: existing tag"),
      new_tag: z.string().optional().describe("For rename/merge: replacement tag"),
      limit: z.number().default(500).describe("Max items/tags to process"),
      confirm: z.boolean().default(false).describe("Required true for query-based update_items and rename/merge/delete"),
    },
    async ({ action, item_keys, query, add_tags, remove_tags, old_tag, new_tag, limit, confirm }) => {
      try {
        if (action === "list") {
          const tags = await zot.getTags(limit);
          if (!tags.length) return ok("No tags found.");
          const sorted = [...tags].sort((a, b) => (b.meta?.numItems ?? 0) - (a.meta?.numItems ?? 0));
          const lines = ["# Zotero Tags", ""];
          for (const tag of sorted) lines.push(`- \`${tag.tag}\` (${tag.meta?.numItems ?? 0} items)`);
          return ok(lines.join("\n"));
        }

        if (action === "update_items") {
          if (!add_tags?.length && !remove_tags?.length) {
            return fail(new Error("Specify at least one of add_tags or remove_tags."));
          }
          const items = await tagTargetItems(item_keys, query, limit);
          if (!items.length) return ok(query ? `No items found matching: ${query}` : "No target items found.");
          if (!item_keys?.length && !confirm) {
            const lines = [
              "# Tag Update Preview",
              `- **Query:** ${query}`,
              `- **Matched items:** ${items.length}`,
              add_tags?.length ? `- **Tags to add:** ${add_tags.join(", ")}` : "",
              remove_tags?.length ? `- **Tags to remove:** ${remove_tags.join(", ")}` : "",
              "",
              "Run again with confirm=true to update query-matched items.",
              "",
              "## Matched Items",
            ].filter(Boolean);
            for (const item of items.slice(0, 30)) lines.push(`- [${item.key}] ${item.data.title || "Untitled"}`);
            if (items.length > 30) lines.push(`- ... and ${items.length - 30} more`);
            return ok(lines.join("\n"));
          }

          let updated = 0;
          const errors: string[] = [];
          for (const item of items) {
            try {
              let tags = [...(item.data.tags ?? [])];
              let changed = false;
              if (add_tags) {
                for (const tag of add_tags) {
                  if (!tags.some((current) => current.tag === tag)) {
                    tags.push({ tag });
                    changed = true;
                  }
                }
              }
              if (remove_tags) {
                const before = tags.length;
                tags = tags.filter((tag) => !remove_tags.includes(tag.tag));
                if (tags.length !== before) changed = true;
              }
              if (changed) {
                await zot.updateItemFields(item.key, { tags });
                updated++;
              }
            } catch (e) {
              errors.push(`${item.key}: ${errorMessage(e)}`);
            }
          }
          const lines = ["# Tag Item Update", `- **Items found:** ${items.length}`, `- **Items updated:** ${updated}`];
          if (add_tags?.length) lines.push(`- **Tags added:** ${add_tags.join(", ")}`);
          if (remove_tags?.length) lines.push(`- **Tags removed:** ${remove_tags.join(", ")}`);
          if (errors.length) lines.push("", "## Errors", ...errors.map((err) => `- ${err}`));
          return ok(lines.join("\n"));
        }

        if (!old_tag) return fail(new Error("old_tag is required for rename/merge/delete actions"));
        if ((action === "rename" || action === "merge") && !new_tag) {
          return fail(new Error("new_tag is required for rename/merge actions"));
        }

        const items = await zot.getItemsByTag(old_tag, limit);
        if (!items.length) return ok(`No items found with tag: ${old_tag}`);
        if (!confirm) {
          const lines = [
            "# Tag Management Preview",
            `- **Action:** ${action}`,
            `- **Old tag:** ${old_tag}`,
            new_tag ? `- **New tag:** ${new_tag}` : "",
            `- **Matched items:** ${items.length}`,
            "",
            "Run again with confirm=true to apply this change.",
            "",
            "## Matched Items",
          ].filter(Boolean);
          for (const item of items.slice(0, 30)) {
            lines.push(`- [${item.key}] ${item.data.title || "Untitled"} (${item.data.itemType})`);
          }
          if (items.length > 30) lines.push(`- ... and ${items.length - 30} more`);
          return ok(lines.join("\n"));
        }

        let updated = 0;
        const errors: string[] = [];
        for (const item of items) {
          try {
            const seen = new Set<string>();
            const nextTags = [];
            for (const tagObj of item.data.tags ?? []) {
              let tag = tagObj.tag;
              if (tag === old_tag) {
                if (action === "delete") continue;
                tag = new_tag as string;
              }
              if (seen.has(tag)) continue;
              seen.add(tag);
              nextTags.push({ ...tagObj, tag });
            }
            await zot.updateItemFields(item.key, { tags: nextTags });
            updated++;
          } catch (e) {
            errors.push(`${item.key}: ${errorMessage(e)}`);
          }
        }

        const lines = [
          "# Tag Management",
          `- **Action:** ${action}`,
          `- **Old tag:** ${old_tag}`,
          new_tag ? `- **New tag:** ${new_tag}` : "",
          `- **Matched items:** ${items.length}`,
          `- **Updated items:** ${updated}`,
        ].filter(Boolean);
        if (errors.length) lines.push("", "## Errors", ...errors.map((err) => `- ${err}`));
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
