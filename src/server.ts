import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import * as zot from "./zotero-client.js";
import * as localDb from "./local-db.js";
import { generateBibtex } from "./bibtex.js";
import {
  formatCreators,
  cleanHtml,
  truncate,
  escapeHtml,
  resolveAttachmentPath,
  errorMessage,
} from "./utils.js";
import type { ZoteroItem } from "./types.js";

export const server = new McpServer({ name: "Zotero", version: "1.0.0" });

// ── Response helpers ──

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: `Error: ${errorMessage(e)}` }],
  isError: true,
});

function str(obj: Record<string, unknown>, key: string, fb = ""): string {
  const v = obj[key];
  return typeof v === "string" ? v : fb;
}

function tagsLine(tags?: Array<{ tag: string }>): string {
  return tags?.length ? tags.map((t) => `\`${t.tag}\``).join(" ") : "";
}

// ── Formatters ──

function fmtItem(item: ZoteroItem, includeAbstract = true): string {
  const d = item.data;
  const lines: string[] = [
    `# ${d.title || "Untitled"}`,
    `**Type:** ${d.itemType}`,
    `**Item Key:** ${d.key}`,
  ];
  if (d.date) lines.push(`**Date:** ${d.date}`);
  if (d.creators?.length) lines.push(`**Authors:** ${formatCreators(d.creators)}`);

  if (d.itemType === "journalArticle" && d.publicationTitle) {
    let info = `**Journal:** ${d.publicationTitle}`;
    if (d.volume) info += `, Volume ${d.volume}`;
    if (d.issue) info += `, Issue ${d.issue}`;
    if (d.pages) info += `, Pages ${d.pages}`;
    lines.push(info);
  } else if (d.itemType === "book" && d.publisher) {
    let info = `**Publisher:** ${d.publisher}`;
    if (d.place) info += `, ${d.place}`;
    lines.push(info);
  }

  if (d.DOI) lines.push(`**DOI:** ${d.DOI}`);
  if (d.url) lines.push(`**URL:** ${d.url}`);

  if (d.extra) {
    lines.push("", "## Extra", d.extra);
    for (const line of d.extra.split("\n")) {
      if (line.toLowerCase().includes("citation key")) {
        const key = line.includes(":") ? line.split(":")[1].trim() : line.trim();
        lines.push(`**Citation Key:** ${key}`);
        break;
      }
    }
  }

  const tl = tagsLine(d.tags);
  if (tl) lines.push(`**Tags:** ${tl}`);
  if (includeAbstract && d.abstractNote) lines.push("", "## Abstract", d.abstractNote);
  if (d.collections?.length) lines.push(`**Collections:** ${d.collections.length} collections`);
  if (item.meta?.numChildren) lines.push(`**Notes/Attachments:** ${item.meta.numChildren}`);

  return lines.join("\n\n");
}

function fmtList(items: ZoteroItem[], title: string): string {
  if (!items.length) return "No items found.";
  const lines = [`# ${title}`, ""];
  for (let i = 0; i < items.length; i++) {
    const d = items[i].data;
    lines.push(`## ${i + 1}. ${d.title || "Untitled"}`);
    lines.push(`**Type:** ${d.itemType}`);
    lines.push(`**Item Key:** ${items[i].key}`);
    if (d.creators?.length) lines.push(`**Authors:** ${formatCreators(d.creators)}`);
    if (d.date) lines.push(`**Date:** ${d.date}`);
    if (d.abstractNote) lines.push(`**Abstract:** ${truncate(d.abstractNote, 200)}`);
    const tl = tagsLine(d.tags);
    if (tl) lines.push(`**Tags:** ${tl}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════
//  1. Search
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "zotero_search_items",
  "Search for items in your Zotero library by keyword.",
  {
    query: z.string().describe("Search query string"),
    qmode: z.enum(["titleCreatorYear", "everything"]).default("titleCreatorYear").describe("Query mode"),
    item_type: z.string().default("-attachment").describe("Item type filter"),
    limit: z.number().default(10).describe("Max results"),
    tag: z.array(z.string()).optional().describe("Tag filters"),
  },
  async ({ query, qmode, item_type, limit, tag }) => {
    try {
      const items = await zot.searchItems(query, { qmode, itemType: item_type, limit, tag });
      return ok(fmtList(items, `Search Results for '${query}'`));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_search_by_tag",
  "Search for items with specific tags.",
  {
    tag: z.array(z.string()).describe("Tags to search for"),
    item_type: z.string().default("-attachment").describe("Item type filter"),
    limit: z.number().default(10).describe("Max results"),
  },
  async ({ tag, item_type, limit }) => {
    try {
      const items = await zot.searchItems("", { itemType: item_type, limit, tag });
      return ok(fmtList(items, `Items tagged: ${tag.join(", ")}`));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_advanced_search",
  "Search with multiple conditions (client-side filtering on title, creator, date, itemType, tag, etc.).",
  {
    conditions: z.array(z.object({ field: z.string(), operator: z.string(), value: z.string() })).describe("Search conditions"),
    join_mode: z.enum(["all", "any"]).default("all"),
    sort_by: z.string().optional(),
    sort_direction: z.enum(["asc", "desc"]).default("asc"),
    limit: z.number().default(50),
  },
  async ({ conditions, join_mode, sort_by, sort_direction, limit }) => {
    try {
      const MAX_SCAN = 2000;
      const BATCH = 100;
      let start = 0;
      const matches: ZoteroItem[] = [];

      while (matches.length < limit && start < MAX_SCAN) {
        const batch = await zot.getItems({ limit: BATCH, start, sort: sort_by, direction: sort_direction, itemType: "-attachment" });
        if (!batch.length) break;

        for (const item of batch) {
          const d = item.data;
          const results = conditions.map(({ field, operator, value }) => {
            const raw =
              field === "creator" ? formatCreators(d.creators ?? []) :
              field === "tag" ? (d.tags ?? []).map((t) => t.tag).join(" ") :
              String(d[field] ?? "");
            const fv = raw.toLowerCase();
            const cv = value.toLowerCase();
            switch (operator) {
              case "contains":        return fv.includes(cv);
              case "is":              return fv === cv;
              case "isNot":           return fv !== cv;
              case "beginsWith":      return fv.startsWith(cv);
              case "doesNotContain":  return !fv.includes(cv);
              case "isLessThan":      return fv < cv;
              case "isGreaterThan":   return fv > cv;
              default:                return fv.includes(cv);
            }
          });
          if (join_mode === "all" ? results.every(Boolean) : results.some(Boolean)) matches.push(item);
          if (matches.length >= limit) break;
        }
        start += BATCH;
        if (batch.length < BATCH) break;
      }

      return ok(fmtList(matches, `Advanced Search (${matches.length} results)`));
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

// ═══════════════════════════════════════════════════════════════════
//  2. Metadata
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "zotero_get_item_metadata",
  "Get detailed metadata for a Zotero item by its key.",
  {
    item_key: z.string().describe("Zotero item key"),
    format: z.enum(["markdown", "bibtex"]).default("markdown"),
  },
  async ({ item_key, format }) => {
    try {
      const item = await zot.getItem(item_key);
      return ok(format === "bibtex" ? await generateBibtex(item) : fmtItem(item));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_get_item_fulltext",
  "Get full text of a Zotero item. Returns indexed text if available, otherwise the PDF file path for external OCR.",
  { item_key: z.string().describe("Zotero item key") },
  async ({ item_key }) => {
    try {
      const item = await zot.getItem(item_key);
      const md = fmtItem(item);
      const children = await zot.getItemChildren(item_key);
      const att = zot.findBestAttachment(children);

      if (!att) return ok(`${md}\n\n---\n\nNo attachment found for this item.`);

      const ft = await zot.getItemFulltext(att.key);
      if (ft?.content) return ok(`${md}\n\n---\n\n## Full Text\n\n${ft.content}`);

      if (att.path) {
        return ok(
          `${md}\n\n---\n\n## Attachment File\n\n` +
          `**File Path:** ${att.path}\n**Content Type:** ${att.contentType}\n**Filename:** ${att.filename}\n\n` +
          `Zotero fulltext index not available. Use the file path above with an OCR tool (e.g. PaddleOCR) to extract text.`
        );
      }

      return ok(`${md}\n\n---\n\nAttachment found (${att.filename}) but file not accessible on disk.`);
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

// ═══════════════════════════════════════════════════════════════════
//  3. Notes
// ═══════════════════════════════════════════════════════════════════

function fmtNotes(notes: ZoteroItem[], title: string, limit: number): string {
  const lines = [`# ${title}`, ""];
  for (const n of notes.slice(0, limit)) {
    lines.push(`## Note (${n.key})`);
    if (n.data.parentItem) lines.push(`**Parent:** ${n.data.parentItem}`);
    lines.push(truncate(cleanHtml(n.data.note || ""), 500));
    lines.push("");
  }
  if (!notes.length) lines.push("No notes found.");
  return lines.join("\n");
}

server.tool(
  "zotero_get_notes",
  "Get notes for a specific item or all notes.",
  {
    item_key: z.string().optional().describe("Item key (omit for all notes)"),
    limit: z.number().default(20),
  },
  async ({ item_key, limit }) => {
    try {
      const notes = item_key
        ? (await zot.getItemChildren(item_key)).filter((c) => c.data.itemType === "note")
        : await zot.getItems({ limit, itemType: "note" });
      return ok(fmtNotes(notes, "Notes", limit));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_search_notes",
  "Search through notes content.",
  {
    query: z.string().describe("Search query"),
    limit: z.number().default(20),
  },
  async ({ query, limit }) => {
    try {
      const items = await zot.searchItems(query, { qmode: "everything", itemType: "note", limit });
      return ok(fmtNotes(items, `Note Search: '${query}'`, limit));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_create_note",
  "Create a new note for a Zotero item. With Web API configured, creates a proper child note; otherwise uses Zotero connector.",
  {
    item_key: z.string().describe("Parent item key"),
    note_title: z.string().describe("Note title"),
    note_text: z.string().describe("Note content (plain text or HTML)"),
    tags: z.array(z.string()).optional().describe("Tags for the note"),
  },
  async ({ item_key, note_title, note_text, tags }) => {
    try {
      const parent = await zot.getItem(item_key);

      const html = note_text.includes("<p>") || note_text.includes("<div>")
        ? note_text
        : note_text.split("\n\n").map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");
      const safeTitle = escapeHtml(note_title.trim());
      const body = safeTitle ? `<h1>${safeTitle}</h1>${html}` : html;

      const result = await zot.createItemNote(item_key, body, tags ?? []);
      const via = zot.hasWebApi() ? "Web API (child note)" : "Connector (standalone)";
      return ok(
        `Note "${note_title}" created for "${parent.data.title || item_key}"\nMethod: ${via}` +
        (result !== "created-via-connector" ? `\nNote key: ${result}` : "")
      );
    } catch (e) { return fail(e); }
  }
);

// ═══════════════════════════════════════════════════════════════════
//  4. Annotations
// ═══════════════════════════════════════════════════════════════════

function fmtAnnotation(d: Record<string, unknown>, key?: string): string[] {
  const t = str(d, "annotationType", "annotation");
  const lines = [key ? `## ${t} (${key})` : `## ${t}`];
  if (d.annotationText) lines.push(`**Text:** ${d.annotationText}`);
  if (d.annotationComment) lines.push(`**Comment:** ${d.annotationComment}`);
  if (d.annotationPageLabel) lines.push(`**Page:** ${d.annotationPageLabel}`);
  if (d.annotationColor) lines.push(`**Color:** ${d.annotationColor}`);
  if (d.parentItem) lines.push(`**Parent:** ${d.parentItem}`);
  lines.push("");
  return lines;
}

server.tool(
  "zotero_get_annotations",
  "Get annotations (highlights, notes) for a Zotero item.",
  {
    item_key: z.string().optional().describe("Item key (omit for all annotations)"),
    limit: z.number().default(50),
  },
  async ({ item_key, limit }) => {
    try {
      let annotations: ZoteroItem[] = [];

      if (item_key) {
        const bbt = await zot.betterBibtexGetAnnotations(item_key);
        if (bbt?.length) {
          const lines = [`# Annotations for ${item_key}`, ""];
          for (const a of bbt.slice(0, limit)) lines.push(...fmtAnnotation(a as Record<string, unknown>));
          return ok(lines.join("\n"));
        }

        const children = await zot.getItemChildren(item_key);
        annotations = children.filter((c) => c.data.itemType === "annotation");

        if (!annotations.length) {
          const atts = children.filter((c) => c.data.itemType === "attachment");
          const nested = await Promise.all(atts.map((a) => zot.getItemChildren(a.key)));
          for (const ch of nested) annotations.push(...ch.filter((c) => c.data.itemType === "annotation"));
        }
      } else {
        annotations = await zot.getItems({ limit, itemType: "annotation" });
      }

      const lines = [`# Annotations${item_key ? ` for ${item_key}` : ""}`, ""];
      for (const a of annotations.slice(0, limit)) {
        lines.push(...fmtAnnotation(a.data as unknown as Record<string, unknown>, a.key));
      }
      if (!annotations.length) lines.push("No annotations found.");
      return ok(lines.join("\n"));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_create_annotation",
  "Create a highlight annotation on a PDF or EPUB attachment. Requires Zotero Web API (ZOTERO_API_KEY) for write access.",
  {
    attachment_key: z.string().describe("Attachment item key"),
    page: z.number().describe("Page number (1-based)"),
    text: z.string().describe("Text to highlight"),
    comment: z.string().optional().describe("Annotation comment"),
    color: z.string().default("#ffd400").describe("Highlight color"),
  },
  async ({ attachment_key, page, text, comment, color }) => {
    try {
      const key = await zot.createAnnotationItem(attachment_key, {
        annotationType: "highlight",
        annotationText: text,
        annotationComment: comment || "",
        annotationColor: color,
        annotationPageLabel: String(page),
        annotationSortIndex: `${String(page - 1).padStart(5, "0")}|000000|00000`,
        annotationPosition: JSON.stringify({ pageIndex: page - 1, rects: [[0, 0, 100, 100]] }),
      });
      return ok(`Annotation created on page ${page} of attachment ${attachment_key}.\nAnnotation key: ${key}`);
    } catch (e) {
      if (errorMessage(e).includes("Web API")) {
        return ok(
          `# Cannot Create Annotation\n\nZotero Web API credentials are required.\n\n` +
          `**To enable:** Set ZOTERO_API_KEY, ZOTERO_LIBRARY_ID, ZOTERO_LIBRARY_TYPE.\n\n` +
          `**Annotation data:** attachment=${attachment_key}, page=${page}, text="${text}"` +
          (comment ? `, comment="${comment}"` : "") + `, color=${color}`
        );
      }
      return fail(e);
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
//  5. Library management
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "zotero_list_libraries",
  "List all libraries (user, group, RSS feeds) accessible in Zotero.",
  {},
  async () => {
    try {
      const libs = localDb.getLibraries();
      const lines = ["# Zotero Libraries", ""];
      for (const lib of libs) {
        if (lib.type === "user") {
          lines.push(`## User Library (ID: ${lib.libraryID})\n- Items: ${lib.itemCount}`);
        } else if (lib.type === "group" && lib.groupName) {
          lines.push(`## Group: ${lib.groupName} (ID: ${lib.groupID})`);
          if (lib.groupDescription) lines.push(`- Description: ${lib.groupDescription}`);
          lines.push(`- Items: ${lib.itemCount}`);
        } else if (lib.type === "feed" && lib.feedName) {
          lines.push(`## Feed: ${lib.feedName}\n- URL: ${lib.feedUrl}\n- Items: ${lib.itemCount}`);
        }
        lines.push("");
      }
      return ok(lines.join("\n"));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_switch_library",
  "Switch the active library (user or group).",
  {
    library_id: z.string().describe("Library ID to switch to"),
    library_type: z.enum(["user", "group"]).default("group"),
  },
  async ({ library_id, library_type }) => {
    zot.setActiveLibrary(library_id, library_type);
    try {
      const items = await zot.getItems({ limit: 1 });
      return ok(`Switched to ${library_type} library ${library_id}. ${items.length ? "Library has items." : "Empty library."}`);
    } catch (e) {
      zot.clearActiveLibrary();
      return fail(new Error(`Failed to switch to ${library_type} library ${library_id}: ${errorMessage(e)}`));
    }
  }
);

server.tool(
  "zotero_list_feeds",
  "List all RSS feed subscriptions in Zotero.",
  {},
  async () => {
    try {
      const feeds = localDb.getFeeds();
      if (!feeds.length) return ok("No RSS feeds configured.");
      const lines = ["# RSS Feeds", ""];
      for (const f of feeds) {
        lines.push(`## ${f.name}\n- **URL:** ${f.url}\n- **Library ID:** ${f.libraryID}\n- **Items:** ${f.itemCount}`);
        if (f.lastUpdate) lines.push(`- **Last Update:** ${f.lastUpdate}`);
        if (f.lastCheckError) lines.push(`- **Error:** ${f.lastCheckError}`);
        lines.push("");
      }
      return ok(lines.join("\n"));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_get_feed_items",
  "Get items from a specific RSS feed.",
  {
    library_id: z.number().describe("Feed library ID"),
    limit: z.number().default(20),
  },
  async ({ library_id, limit }) => {
    try {
      const feeds = localDb.getFeeds();
      const feedName = feeds.find((f) => f.libraryID === library_id)?.name || `Feed ${library_id}`;
      const items = localDb.getFeedItems(library_id, limit);
      const lines = [`# Feed Items: ${feedName}`, ""];
      for (const item of items) {
        lines.push(`## ${item.title || "Untitled"}`);
        lines.push(`- **Key:** ${item.key}`);
        if (item.creators) lines.push(`- **Authors:** ${item.creators}`);
        if (item.url) lines.push(`- **URL:** ${item.url}`);
        if (item.dateAdded) lines.push(`- **Date:** ${item.dateAdded}`);
        if (item.abstract) lines.push(`- **Abstract:** ${truncate(item.abstract, 200)}`);
        lines.push("");
      }
      if (!items.length) lines.push("No feed items found.");
      return ok(lines.join("\n"));
    } catch (e) { return fail(e); }
  }
);

server.tool(
  "zotero_batch_update_tags",
  "Batch add or remove tags on items matching a search query. Requires Zotero Web API for write access; without it, shows a preview.",
  {
    query: z.string().describe("Search query to find items"),
    add_tags: z.array(z.string()).optional().describe("Tags to add"),
    remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
    limit: z.number().default(50),
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
          `# Batch Tag Update`, `- **Query:** ${query}`,
          `- **Items found:** ${items.length}`, `- **Items updated:** ${updated}`,
        ];
        if (add_tags?.length) lines.push(`- **Tags added:** ${add_tags.join(", ")}`);
        if (remove_tags?.length) lines.push(`- **Tags removed:** ${remove_tags.join(", ")}`);
        if (errors.length) { lines.push("", "## Errors"); for (const e of errors) lines.push(`- ${e}`); }
        return ok(lines.join("\n"));
      }

      // Preview mode (no Web API)
      const lines = [
        `# Batch Tag Update (Preview)`, `- **Query:** ${query}`, `- **Items matched:** ${items.length}`,
      ];
      if (add_tags?.length) lines.push(`- **Tags to add:** ${add_tags.join(", ")}`);
      if (remove_tags?.length) lines.push(`- **Tags to remove:** ${remove_tags.join(", ")}`);
      lines.push("", "## Matched Items");
      for (const item of items) {
        const cur = (item.data.tags ?? []).map((t) => t.tag).join(", ") || "(none)";
        lines.push(`- **${item.data.title || "Untitled"}** [${item.key}] — tags: ${cur}`);
      }
      lines.push("", "---", "**Note:** Set ZOTERO_API_KEY and ZOTERO_LIBRARY_ID to apply changes.");
      return ok(lines.join("\n"));
    } catch (e) { return fail(e); }
  }
);
