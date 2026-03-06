import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as zot from "../zotero-client.js";
import { generateBibtex } from "../bibtex.js";
import { cleanHtml, truncate, resolveAttachmentPath } from "../utils.js";
import { ok, fail, fmtItem, fmtList, tagsLine } from "../formatters.js";

export function registerMetadataTools(server: McpServer): void {
  server.tool(
    "zotero_get_item_metadata",
    "Get detailed metadata for a Zotero item. Includes PDF file path when available.",
    {
      item_key: z.string().describe("Zotero item key"),
      format: z.enum(["markdown", "bibtex"]).default("markdown"),
    },
    async ({ item_key, format }) => {
      try {
        const item = await zot.getItem(item_key);
        if (format === "bibtex") return ok(await generateBibtex(item));

        const md = fmtItem(item);
        const children = await zot.getItemChildren(item_key);
        const att = zot.findBestAttachment(children);
        if (att?.path) return ok(`${md}\n\n**PDF Path:** ${att.path}`);
        return ok(md);
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_item_pdfpath",
    "Get the absolute PDF file path for a Zotero item. Returns the path directly for use with external tools like PaddleOCR.",
    { item_key: z.string().describe("Zotero item key") },
    async ({ item_key }) => {
      try {
        const item = await zot.getItem(item_key);
        const d = item.data;
        const children = await zot.getItemChildren(item_key);
        const att = zot.findBestAttachment(children);

        const lines: string[] = [
          `**Title:** ${d.title || "Untitled"}`,
          `**Item Key:** ${d.key}`,
        ];
        if (d.creators?.length) {
          const first = d.creators[0];
          const name = first.lastName || first.name || "";
          lines.push(`**First Author:** ${name}`);
        }
        if (d.DOI) lines.push(`**DOI:** ${d.DOI}`);

        if (!att) return ok(lines.join("\n") + "\n\n**PDF Path:** Not found (no attachment)");
        if (!att.path) return ok(lines.join("\n") + `\n\n**PDF Path:** Not accessible on disk (${att.filename})`);

        lines.push(`\n**PDF Path:** ${att.path}`);
        lines.push(`**Content Type:** ${att.contentType}`);
        lines.push(`**Filename:** ${att.filename}`);

        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_item_children",
    "Get child items (attachments, notes) for a Zotero item.",
    { item_key: z.string().describe("Zotero item key") },
    async ({ item_key }) => {
      try {
        const parent = await zot.getItem(item_key);
        const children = await zot.getItemChildren(item_key);
        const lines = [`# Children of: ${parent.data.title || "Untitled"}`, ""];

        for (const child of children) {
          const cd = child.data;
          if (cd.itemType === "attachment") {
            lines.push(`## Attachment: ${cd.title || cd.filename || "Untitled"}`);
            lines.push(`- **Key:** ${child.key}`);
            lines.push(`- **Type:** ${cd.contentType || "unknown"}`);
            lines.push(`- **Filename:** ${cd.filename || "N/A"}`);
            const fp = resolveAttachmentPath(child.key, typeof cd.path === "string" ? cd.path : undefined);
            if (fp) lines.push(`- **File Path:** ${fp}`);
          } else if (cd.itemType === "note") {
            lines.push(`## Note`);
            lines.push(`- **Key:** ${child.key}`);
            lines.push(`- **Content:** ${truncate(cleanHtml(cd.note || ""), 300)}`);
          } else {
            lines.push(`## ${cd.itemType}: ${cd.title || "Untitled"}`);
            lines.push(`- **Key:** ${child.key}`);
          }
          lines.push("");
        }

        if (!children.length) lines.push("No children found.");
        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_collections",
    "List all collections in your Zotero library.",
    { limit: z.number().optional().describe("Max collections to return") },
    async ({ limit }) => {
      try {
        const collections = await zot.getCollections(limit);
        const lines = ["# Zotero Collections", ""];
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
          const out = [`${"  ".repeat(lvl)}- **${c.data.name}** (Key: ${key})`];
          for (const ck of tree[key] ?? []) out.push(...render(ck, lvl + 1));
          return out;
        }

        const roots = tree["__root__"];
        if (roots?.length) {
          for (const k of roots) lines.push(...render(k, 0));
        } else {
          for (const c of collections) lines.push(`- **${c.data.name}** (Key: ${c.key})`);
        }

        return ok(lines.join("\n"));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_collection_items",
    "Get items in a specific collection.",
    {
      collection_key: z.string().describe("Collection key"),
      limit: z.number().default(50).describe("Max items"),
    },
    async ({ collection_key, limit }) => {
      try {
        const [items, col] = await Promise.all([
          zot.getCollectionItems(collection_key, limit),
          zot.getCollection(collection_key),
        ]);
        return ok(fmtList(items, `Collection: ${col.data.name}`));
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "zotero_get_tags",
    "List all tags in your Zotero library.",
    { limit: z.number().optional().describe("Max tags") },
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
}
