import {
  formatCreators,
  cleanHtml,
  truncate,
  errorMessage,
  resolveItemFiles,
} from "./utils.js";
import { getAttachmentsForParents } from "./local-db.js";
import type { ZoteroItem, ZoteroAnnotationData, ItemFiles, FileInventoryEntry } from "./types.js";

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
  if (files.hasMd) parts.push("📘MD");
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

// ── Suggested next actions ──

export function suggestNext(context: string): string {
  const hints: Record<string, string> = {
    search:
      "**suggested_next:** `zotero_item` 查看文件库存 -> `zotero_texts` action=read 读取 MD/TXT -> `zotero_texts` action=ocr 转换 PDF",
    item:
      "**suggested_next:** `zotero_texts` action=read 读取 MD/TXT -> `zotero_notes` action=create 保存笔记 -> `zotero_texts` action=write 补充 MD/TXT",
    item_no_ocr:
      "**suggested_next:** `zotero_texts` action=ocr 转换 PDF -> `zotero_texts` action=write 保存 MD/TXT -> `zotero_texts` action=read 读取文本",
    ocr:
      "**suggested_next:** `zotero_texts` action=read 读取 MD/TXT -> `zotero_notes` action=create 保存笔记",
    note_created:
      "**suggested_next:** `zotero_notes` action=search 搜索笔记 -> `zotero_export` 导出 BibTeX -> `zotero_tags` action=update_items 整理标签",
    export:
      "**suggested_next:** `zotero_search` 查找更多文献 -> `zotero_tags` action=update_items 整理标签",
    import:
      "**suggested_next:** `zotero_item` 查看导入结果 -> `zotero_texts` action=ocr 转换 PDF -> `zotero_collections` 整理到文件夹",
    read_file:
      "**suggested_next:** `zotero_notes` action=create 保存阅读笔记 -> `zotero_export` 导出 BibTeX",
  };
  return hints[context] || "";
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
    const files = fileMap.get(items[i].key) ?? { hasPdf: false, hasTxt: false, hasMd: false };
    lines.push(`${i + 1}. ${d.title || "Untitled"} [${items[i].key}] ${fileTag(files)}`);
    lines.push(`   ${shortAuthors(d.creators)} · ${d.date || "n.d."} · ${d.itemType}`);
    lines.push("");
  }
  lines.push(suggestNext("search"));
  return lines.join("\n");
}

// ── Comprehensive item format (everything in one response) ──

export interface ComprehensiveData {
  fileInventory: FileInventoryEntry[];
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

  lines.push("", "## File Inventory");
  let hasReadableText = false;
  if (!extra.fileInventory.length) {
    lines.push("No attachments found.");
  } else {
    lines.push("| Attachment | PDF | MD | TXT |");
    lines.push("|---|---:|---:|---:|");
    for (const entry of extra.fileInventory) {
      const f = entry.files;
      if (f.hasMd || f.hasTxt) hasReadableText = true;
      lines.push(`| [${entry.attachmentKey}] ${entry.title} | ${f.hasPdf ? "yes" : "no"} | ${f.hasMd ? "yes" : "no"} | ${f.hasTxt ? "yes" : "no"} |`);
      if (f.pdfPath) lines.push(`| PDF path |  |  | ${f.pdfPath} |`);
      if (f.mdPath) lines.push(`| MD path |  |  | ${f.mdPath}${f.mdSize ? ` (${(f.mdSize / 1024).toFixed(1)} KB)` : ""} |`);
      if (f.txtPath) lines.push(`| TXT path |  |  | ${f.txtPath}${f.txtSize ? ` (${(f.txtSize / 1024).toFixed(1)} KB)` : ""} |`);
    }
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

  // Suggested next
  lines.push("");
  lines.push(suggestNext(hasReadableText ? "item" : "item_no_ocr"));

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
