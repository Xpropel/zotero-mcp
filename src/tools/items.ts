import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { errorMessage } from "../utils.js";
import { ok, fail } from "../formatters.js";

function inputItemKeys(itemKey?: string, itemKeys?: string[]): string[] {
  const keys = itemKeys?.length ? itemKeys : itemKey ? [itemKey] : [];
  if (!keys.length) throw new Error("item_key or item_keys is required");
  return keys;
}

function commonFieldPatch(args: {
  title?: string;
  date?: string;
  abstract?: string;
  doi?: string;
  url?: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  extra?: string;
  tags?: string[];
  fields?: Record<string, unknown>;
}): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...(args.fields ?? {}) };
  if (args.title !== undefined) fields.title = args.title;
  if (args.date !== undefined) fields.date = args.date;
  if (args.abstract !== undefined) fields.abstractNote = args.abstract;
  if (args.doi !== undefined) fields.DOI = args.doi;
  if (args.url !== undefined) fields.url = args.url;
  if (args.journal !== undefined) fields.publicationTitle = args.journal;
  if (args.volume !== undefined) fields.volume = args.volume;
  if (args.issue !== undefined) fields.issue = args.issue;
  if (args.pages !== undefined) fields.pages = args.pages;
  if (args.extra !== undefined) fields.extra = args.extra;
  if (args.tags !== undefined) fields.tags = args.tags.map((tag) => ({ tag }));
  return fields;
}

export function registerItemManagementTools(server: McpServer): void {
  server.tool(
    "zotero_items",
    "Create, update, delete, or check duplicate Zotero item records. Use zotero_import for DOI-based imports.",
    {
      action: z.enum(["create", "update", "delete", "duplicates"]).describe("Action to perform"),
      item_key: z.string().optional().describe("Single item key for update/delete"),
      item_keys: z.array(z.string()).optional().describe("Item keys for delete"),
      item_type: z.string().default("journalArticle").describe("Zotero item type for create"),
      title: z.string().optional().describe("Title for create/update"),
      creators: z.array(z.object({
        creatorType: z.string().default("author"),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        name: z.string().optional(),
      })).optional().describe("Creators for create"),
      fields: z.record(z.any()).optional().describe("Additional Zotero fields for create/update"),
      collection_keys: z.array(z.string()).optional().describe("Collections for create"),
      collection_key: z.string().optional().describe("Collection key for duplicate scan scope"),
      tags: z.array(z.string()).optional().describe("Tags for create/update; update replaces item tags"),
      date: z.string().optional().describe("Date field for update"),
      abstract: z.string().optional().describe("Abstract for update"),
      doi: z.string().optional().describe("DOI field for update"),
      url: z.string().optional().describe("URL for update"),
      journal: z.string().optional().describe("Journal/publication title for update"),
      volume: z.string().optional().describe("Volume for update"),
      issue: z.string().optional().describe("Issue for update"),
      pages: z.string().optional().describe("Pages for update"),
      extra: z.string().optional().describe("Extra field for update"),
      scope: z.enum(["all", "collection"]).default("all").describe("For duplicates: scan all or one collection"),
      limit: z.number().default(100).describe("For duplicates: max items to scan"),
      confirm: z.boolean().default(false).describe("Required true for delete"),
      permanent: z.boolean().default(false).describe("For delete: permanently erase instead of moving to trash"),
    },
    async (args) => {
      try {
        if (args.action === "create") {
          if (!args.title) return fail(new Error("title is required for create action"));
          const payload: Record<string, unknown> = {
            ...(args.fields ?? {}),
            itemType: args.item_type,
            title: args.title,
          };
          if (args.creators?.length) payload.creators = args.creators;
          if (args.collection_keys?.length) payload.collections = args.collection_keys;
          if (args.tags?.length) payload.tags = args.tags.map((tag) => ({ tag }));
          const key = await zot.createItem(payload);
          return ok(
            `Item created: **${args.title}** [${key}]\n\n` +
              `Next: call \`zotero_item\` with item_key=\`${key}\` to verify it locally.`
          );
        }

        if (args.action === "update") {
          if (!args.item_key) return fail(new Error("item_key is required for update action"));
          const fields = commonFieldPatch(args);
          if (!Object.keys(fields).length) {
            return fail(new Error("No fields to update. Provide fields or at least one metadata field."));
          }
          await zot.updateItemFields(args.item_key, fields);
          return ok(`Item [${args.item_key}] updated locally: ${Object.keys(fields).join(", ")}`);
        }

        if (args.action === "delete") {
          const keys = inputItemKeys(args.item_key, args.item_keys);
          const items = await Promise.all(keys.map((key) => zot.getItem(key)));
          if (!args.confirm) {
            const lines = ["# Delete Preview", "", "Run again with confirm=true to delete these items.", ""];
            for (const item of items) {
              lines.push(`- [${item.key}] ${item.data.title || "Untitled"} (${item.data.itemType})`);
            }
            return ok(lines.join("\n"));
          }

          const deleted: string[] = [];
          const errors: string[] = [];
          for (const item of items) {
            try {
              await zot.deleteItem(item.key, args.permanent);
              deleted.push(`${item.key}: ${item.data.title || "Untitled"}`);
            } catch (e) {
              errors.push(`${item.key}: ${errorMessage(e)}`);
            }
          }
          const lines = ["# Delete Items", `- **Requested:** ${keys.length}`, `- **Deleted:** ${deleted.length}`];
          if (deleted.length) lines.push("", "## Deleted", ...deleted.map((item) => `- ${item}`));
          if (errors.length) lines.push("", "## Errors", ...errors.map((err) => `- ${err}`));
          return ok(lines.join("\n"));
        }

        let items: Awaited<ReturnType<typeof zot.getItems>>;
        if (args.scope === "collection" && args.collection_key) {
          items = await zot.getCollectionItems(args.collection_key, args.limit);
        } else {
          items = await zot.getItems({ limit: args.limit, sort: "title", direction: "asc", itemType: "-attachment" });
        }

        const doiGroups = new Map<string, typeof items>();
        const titleGroups = new Map<string, typeof items>();
        for (const item of items) {
          if (item.data.itemType === "note" || item.data.itemType === "attachment") continue;
          const doi = item.data.DOI?.toLowerCase().trim();
          if (doi) {
            const group = doiGroups.get(doi) ?? [];
            group.push(item);
            doiGroups.set(doi, group);
          }
          const title = (item.data.title || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
          if (title.length > 10) {
            const group = titleGroups.get(title) ?? [];
            group.push(item);
            titleGroups.set(title, group);
          }
        }

        const dupSets: Array<{ reason: string; items: typeof items }> = [];
        const seen = new Set<string>();
        for (const [doi, group] of doiGroups) {
          if (group.length < 2) continue;
          const keys = group.map((item) => item.key).sort().join(",");
          if (seen.has(keys)) continue;
          seen.add(keys);
          dupSets.push({ reason: `DOI: ${doi}`, items: group });
        }
        for (const [, group] of titleGroups) {
          if (group.length < 2) continue;
          const keys = group.map((item) => item.key).sort().join(",");
          if (seen.has(keys)) continue;
          seen.add(keys);
          dupSets.push({ reason: "Title match", items: group });
        }

        if (!dupSets.length) return ok(`# Duplicate Check\nScanned ${items.length} items - no duplicates found.`);
        const lines = ["# Duplicate Check", `Scanned ${items.length} items - found ${dupSets.length} duplicate group(s)`, ""];
        for (let i = 0; i < dupSets.length; i++) {
          lines.push(`## Group ${i + 1} (${dupSets[i].reason})`);
          for (const item of dupSets[i].items) {
            lines.push(`- [${item.key}] ${item.data.title || "Untitled"} (${item.data.date || "n.d."}) - ${item.data.itemType}`);
          }
          lines.push("");
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
