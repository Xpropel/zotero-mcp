import {
  formatCreators,
  cleanHtml,
  truncate,
  errorMessage,
} from "./utils.js";
import type { ZoteroItem, ZoteroAnnotationData } from "./types.js";

// ── Response helpers ──

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(e)}` }], isError: true };
}

export function tagsLine(tags?: Array<{ tag: string }>): string {
  return tags?.length ? tags.map((t) => `\`${t.tag}\``).join(" ") : "";
}

// ── Item formatters ──

export function fmtItem(item: ZoteroItem, includeAbstract = true): string {
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

export function fmtList(items: ZoteroItem[], title: string): string {
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

export function fmtNotes(notes: ZoteroItem[], title: string, limit: number): string {
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

export function fmtAnnotation(d: ZoteroAnnotationData, key?: string): string[] {
  const t = d.annotationType || "annotation";
  const lines = [key ? `## ${t} (${key})` : `## ${t}`];
  if (d.annotationText) lines.push(`**Text:** ${d.annotationText}`);
  if (d.annotationComment) lines.push(`**Comment:** ${d.annotationComment}`);
  if (d.annotationPageLabel) lines.push(`**Page:** ${d.annotationPageLabel}`);
  if (d.annotationColor) lines.push(`**Color:** ${d.annotationColor}`);
  if (d.parentItem) lines.push(`**Parent:** ${d.parentItem}`);
  lines.push("");
  return lines;
}
