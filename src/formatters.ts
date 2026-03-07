import {
  formatCreators,
  cleanHtml,
  truncate,
  errorMessage,
  resolveItemFiles,
} from "./utils.js";
import { getAttachmentsForParents } from "./local-db.js";
import type { ZoteroItem, ZoteroAnnotationData, ItemFiles } from "./types.js";

// ── Response helpers ──

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function fail(e: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(e)}` }], isError: true };
}

// ── File indicators ──

function fileTag(files: ItemFiles): string {
  const parts: string[] = [];
  if (files.hasPdf) parts.push("📄PDF");
  if (files.hasTxt) parts.push("📝TXT");
  if (!parts.length) return "⚠️无附件";
  return parts.join(" ");
}

function shortAuthors(creators?: Array<{ firstName?: string; lastName?: string; name?: string }>): string {
  if (!creators?.length) return "Unknown";
  const first = creators[0];
  const name = first.lastName || first.name || "Unknown";
  return creators.length > 2 ? `${name} et al.` : creators.length === 2
    ? `${name}, ${creators[1].lastName || creators[1].name || ""}` : name;
}

// ── Lean search result format (no abstracts, with file indicators) ──

export function fmtSearchList(items: ZoteroItem[], title: string): string {
  if (!items.length) return "No items found.";

  const keys = items.map((i) => i.key);
  const attRows = getAttachmentsForParents(keys);
  const fileMap = new Map<string, ItemFiles>();
  for (const row of attRows) {
    if (fileMap.has(row.parentKey)) continue;
    fileMap.set(row.parentKey, resolveItemFiles(row.attachmentKey, row.path ?? undefined));
  }

  const lines = [`# ${title} (${items.length} results)`, ""];
  for (let i = 0; i < items.length; i++) {
    const d = items[i].data;
    const files = fileMap.get(items[i].key) ?? { hasPdf: false, hasTxt: false };
    lines.push(`${i + 1}. ${d.title || "Untitled"} [${items[i].key}] ${fileTag(files)}`);
    lines.push(`   ${shortAuthors(d.creators)} · ${d.date || "n.d."} · ${d.itemType}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Comprehensive item format (everything in one response) ──

export interface ComprehensiveData {
  pdfPath?: string;
  txtPath?: string;
  txtSize?: number;
  pdfFilename?: string;
  notes: ZoteroItem[];
  annotations: Array<ZoteroAnnotationData & { key?: string }>;
}

export function fmtComprehensiveItem(item: ZoteroItem, extra: ComprehensiveData): string {
  const d = item.data;
  const lines: string[] = [`# ${d.title || "Untitled"}`];

  lines.push(`**Key:** ${d.key} | **Type:** ${d.itemType} | **Date:** ${d.date || "n.d."}`);
  if (d.creators?.length) lines.push(`**Authors:** ${formatCreators(d.creators)}`);

  if (d.itemType === "journalArticle" && d.publicationTitle) {
    let info = `**Journal:** ${d.publicationTitle}`;
    if (d.volume) info += `, Vol ${d.volume}`;
    if (d.issue) info += `, Issue ${d.issue}`;
    if (d.pages) info += `, pp. ${d.pages}`;
    lines.push(info);
  } else if (d.itemType === "book" && d.publisher) {
    let info = `**Publisher:** ${d.publisher}`;
    if (d.place) info += `, ${d.place}`;
    lines.push(info);
  } else if (d.itemType === "conferencePaper" && d.publicationTitle) {
    lines.push(`**Conference:** ${d.publicationTitle}`);
  }

  if (d.DOI) lines.push(`**DOI:** ${d.DOI}`);
  if (d.url) lines.push(`**URL:** ${d.url}`);

  const tags = d.tags?.map((t) => `\`${t.tag}\``).join(" ");
  if (tags) lines.push(`**Tags:** ${tags}`);

  if (d.extra) {
    for (const line of d.extra.split("\n")) {
      if (line.toLowerCase().includes("citation key")) {
        const key = line.includes(":") ? line.split(":")[1].trim() : line.trim();
        lines.push(`**Citation Key:** ${key}`);
        break;
      }
    }
  }

  // Abstract
  if (d.abstractNote) {
    lines.push("", "## Abstract", d.abstractNote);
  }

  // Files section
  lines.push("", "## Files");
  if (extra.pdfPath) {
    lines.push(`📄 **PDF:** ${extra.pdfPath}`);
  } else {
    lines.push("📄 **PDF:** Not found");
  }
  if (extra.txtPath) {
    const sizeKB = extra.txtSize ? ` (${(extra.txtSize / 1024).toFixed(1)} KB)` : "";
    lines.push(`📝 **TXT:** ${extra.txtPath}${sizeKB}`);
    lines.push("→ 全文已转换，可直接读取 TXT 文件，无需调用 PaddleOCR");
  } else if (extra.pdfPath) {
    lines.push("📝 **TXT:** 尚未转换 — 可通过 PaddleOCR 转换后用 zotero_save_txt 保存");
  }

  // Notes
  if (extra.notes.length) {
    lines.push("", `## Notes (${extra.notes.length})`);
    for (const n of extra.notes.slice(0, 10)) {
      const preview = truncate(cleanHtml(n.data.note || ""), 200);
      lines.push(`- [${n.key}] ${preview}`);
    }
    if (extra.notes.length > 10) lines.push(`- ... and ${extra.notes.length - 10} more`);
  }

  // Annotations
  if (extra.annotations.length) {
    lines.push("", `## Annotations (${extra.annotations.length})`);
    for (const a of extra.annotations.slice(0, 15)) {
      const type = a.annotationType || "annotation";
      const page = a.annotationPageLabel ? `p.${a.annotationPageLabel}` : "";
      const text = a.annotationText ? `"${truncate(a.annotationText, 80)}"` : "";
      const comment = a.annotationComment ? ` — ${truncate(a.annotationComment, 60)}` : "";
      lines.push(`- ${page} [${type}] ${text}${comment}`);
    }
    if (extra.annotations.length > 15) lines.push(`- ... and ${extra.annotations.length - 15} more`);
  }

  return lines.join("\n");
}

// ── Notes formatter ──

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
