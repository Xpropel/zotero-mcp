#!/usr/bin/env node

/**
 * Zotero CLI v3.5.1 — 命令行工具，直接操作本地 Zotero 文献库
 *
 * 命令：
 *   search      搜索文献
 *   item        查看文献详情
 *   ocr         PaddleOCR 转换 PDF
 *   notes       搜索笔记
 *   note        创建笔记
 *   collections 浏览文件夹
 *   tags        查看标签
 *   tag         批量打标签
 *   export      导出 BibTeX
 *   libraries   列出库
 *   status      系统状态
 */

import { Command } from "commander";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { getCrossRefMeta, findOaPdf, downloadPdf, metaToZoteroPayload } from "./doi-import.js";
import * as zot from "./zotero-client.js";
import * as localDb from "./local-db.js";
import { resolveItemFiles, formatCreators, cleanHtml, truncate, findZoteroDataDir, suggestTxtFilename } from "./utils.js";
import { generateBibtex } from "./bibtex.js";
import { ocrPdf, saveOcrResult, saveOcrImages } from "./paddle-ocr.js";
import type { OcrFormat } from "./paddle-ocr.js";
import type { ZoteroItem, ZoteroAnnotationData, ItemFiles } from "./types.js";

// ── ANSI colors ──
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function fileTag(files: ItemFiles): string {
  const parts: string[] = [];
  if (files.hasPdf) parts.push(`${c.green}PDF${c.reset}`);
  if (files.hasMd) parts.push(`${c.blue}MD${c.reset}`);
  if (files.hasTxt) parts.push(`${c.cyan}TXT${c.reset}`);
  return parts.length ? parts.join(" ") : `${c.dim}无附件${c.reset}`;
}

function shortAuthors(creators?: Array<{ firstName?: string; lastName?: string; name?: string }>): string {
  if (!creators?.length) return "Unknown";
  const first = creators[0];
  const name = first.lastName || first.name || "Unknown";
  return creators.length > 2 ? `${name} et al.` : creators.length === 2
    ? `${name}, ${creators[1].lastName || creators[1].name || ""}` : name;
}

const program = new Command();
program
  .name("zotero_manager")
  .description("Zotero 文献库命令行工具 v3.5.1")
  .version("3.5.1");

// ── search ──
program
  .command("search [query]")
  .description("搜索 Zotero 文献库")
  .option("-t, --tag <tags...>", "按标签筛选")
  .option("-c, --collection <key>", "限定文件夹")
  .option("-T, --type <type>", "条目类型筛选 (journalArticle|book|conferencePaper|...)")
  .option("-y, --year <range>", "年份范围 (如 2020-2024 或 2023)")
  .option("-s, --sort <field>", "排序字段 (dateAdded|dateModified|title|date)", "dateAdded")
  .option("-d, --direction <dir>", "排序方向 (asc|desc)", "desc")
  .option("-n, --limit <n>", "最大结果数", "20")
  .option("--json", "JSON 输出")
  .action(async (query, opts) => {
    try {
      const itemType = opts.type || "-attachment";
      let items: ZoteroItem[];
      if (opts.collection) {
        items = await zot.getCollectionItems(opts.collection, Number(opts.limit));
      } else if (query) {
        items = await zot.searchItems(query, {
          qmode: "everything",
          itemType,
          limit: Number(opts.limit),
          tag: opts.tag,
          sort: opts.sort,
          direction: opts.direction,
        });
      } else {
        items = await zot.getItems({
          limit: Number(opts.limit),
          sort: opts.sort,
          direction: opts.direction,
          itemType,
        });
      }

      // Year range filter
      if (opts.year) {
        const parts = opts.year.split("-");
        const yFrom = parseInt(parts[0], 10);
        const yTo = parts[1] ? parseInt(parts[1], 10) : yFrom;
        items = items.filter((it: ZoteroItem) => {
          const m = (it.data.date || "").match(/(\d{4})/);
          if (!m) return false;
          const y = parseInt(m[1], 10);
          return y >= yFrom && y <= yTo;
        });
      }

      if (opts.json) { console.log(JSON.stringify(items, null, 2)); return; }

      if (!items.length) { console.log("No items found."); return; }

      const keys = items.map((i) => i.key);
      const attRows = localDb.getAttachmentsForParents(keys);
      const fileMap = new Map<string, ItemFiles>();
      for (const row of attRows) {
        if (fileMap.has(row.parentKey)) continue;
        fileMap.set(row.parentKey, resolveItemFiles(row.attachmentKey, row.path ?? undefined));
      }

      const label = query ? `Search: "${query}"` : "Recent Items";
      console.log(`\n${c.bold}${label}${c.reset} (${items.length} results)\n`);

      for (let i = 0; i < items.length; i++) {
        const d = items[i].data;
        const files = fileMap.get(items[i].key) ?? { hasPdf: false, hasTxt: false, hasMd: false };
        console.log(`  ${c.dim}${String(i + 1).padStart(2)}.${c.reset} ${c.bold}${d.title || "Untitled"}${c.reset} ${c.dim}[${items[i].key}]${c.reset} ${fileTag(files)}`);
        console.log(`      ${c.dim}${shortAuthors(d.creators)} · ${d.date || "n.d."} · ${d.itemType}${c.reset}`);
      }
      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── item ──
program
  .command("item <key>")
  .description("查看文献详情")
  .option("--json", "JSON 输出")
  .action(async (key, opts) => {
    try {
      const item = await zot.getItem(key);
      const children = await zot.getItemChildren(key);
      const att = zot.findBestAttachment(children);

      if (opts.json) {
        console.log(JSON.stringify({ item, children: children.length }, null, 2));
        return;
      }

      const d = item.data;
      console.log(`\n${c.bold}${d.title || "Untitled"}${c.reset}`);
      console.log(`${c.dim}Key: ${d.key} | Type: ${d.itemType} | Date: ${d.date || "n.d."}${c.reset}`);
      if (d.creators?.length) console.log(`${c.cyan}Authors:${c.reset} ${formatCreators(d.creators)}`);
      if (d.DOI) console.log(`${c.cyan}DOI:${c.reset} ${d.DOI}`);
      if (d.publicationTitle) console.log(`${c.cyan}Journal:${c.reset} ${d.publicationTitle}`);

      const tags = d.tags?.map((t) => t.tag).join(", ");
      if (tags) console.log(`${c.cyan}Tags:${c.reset} ${tags}`);

      if (d.abstractNote) {
        console.log(`\n${c.bold}Abstract${c.reset}`);
        console.log(d.abstractNote);
      }

      // Files
      console.log(`\n${c.bold}Files${c.reset}`);
      if (att) {
        const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);
        if (files.pdfPath) console.log(`  ${c.green}📄 PDF:${c.reset} ${files.pdfPath}`);
        if (files.mdPath) console.log(`  ${c.blue}📘 MD:${c.reset} ${files.mdPath} (${((files.mdSize || 0) / 1024).toFixed(1)} KB)`);
        if (files.txtPath) console.log(`  ${c.cyan}📝 TXT:${c.reset} ${files.txtPath} (${((files.txtSize || 0) / 1024).toFixed(1)} KB)`);
        if (!files.mdPath && !files.txtPath && files.pdfPath) {
          console.log(`  ${c.yellow}⚠ 尚未 OCR — 运行 zotero ocr ${key}${c.reset}`);
        }
      } else {
        console.log(`  ${c.dim}No attachments${c.reset}`);
      }

      // Notes
      const notes = children.filter((ch) => ch.data.itemType === "note");
      if (notes.length) {
        console.log(`\n${c.bold}Notes (${notes.length})${c.reset}`);
        for (const n of notes.slice(0, 5)) {
          console.log(`  ${c.dim}[${n.key}]${c.reset} ${truncate(cleanHtml(n.data.note || ""), 120)}`);
        }
      }

      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── ocr ──
program
  .command("ocr <key>")
  .description("使用 PaddleOCR 转换 PDF 为文本")
  .option("-f, --format <fmt>", "输出格式 (md|json|txt)", "md")
  .option("--images", "同时保存图片")
  .action(async (key, opts) => {
    try {
      const item = await zot.getItem(key);
      const children = await zot.getItemChildren(key);
      const att = zot.findBestAttachment(children);
      if (!att) { console.error(`${c.red}No attachment found${c.reset}`); process.exit(1); }

      const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);
      if (!files.pdfPath) { console.error(`${c.red}PDF not found on disk${c.reset}`); process.exit(1); }

      const title = item.data.title || "Untitled";
      console.log(`\n${c.bold}OCR: ${title}${c.reset}`);
      console.log(`${c.dim}PDF: ${files.pdfPath}${c.reset}`);
      console.log(`${c.yellow}调用 PaddleOCR API...${c.reset}`);

      const result = await ocrPdf(files.pdfPath);
      const fmt = opts.format as OcrFormat;
      const savePath = saveOcrResult(files.pdfPath, result, fmt);
      const size = statSync(savePath).size;

      console.log(`${c.green}✓${c.reset} 转换完成`);
      console.log(`  Pages: ${result.pages.length}`);
      console.log(`  Format: ${fmt}`);
      console.log(`  Saved: ${savePath} (${(size / 1024).toFixed(1)} KB)`);
      console.log(`  Characters: ${result.fullText.length.toLocaleString()}`);

      // Also save txt backup if format != txt
      if (fmt !== "txt") {
        const txtPath = saveOcrResult(files.pdfPath, result, "txt");
        console.log(`  TXT backup: ${txtPath}`);
      }

      if (opts.images) {
        const imgs = await saveOcrImages(files.pdfPath, result);
        if (imgs.length) console.log(`  Images: ${imgs.length} files`);
      }

      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── notes ──
program
  .command("notes <query>")
  .description("搜索笔记")
  .option("-n, --limit <n>", "最大结果数", "20")
  .action(async (query, opts) => {
    try {
      const items = await zot.searchItems(query, { qmode: "everything", itemType: "note", limit: Number(opts.limit) });
      if (!items.length) { console.log("No notes found."); return; }

      console.log(`\n${c.bold}Note Search: "${query}"${c.reset} (${items.length} results)\n`);
      for (const n of items) {
        console.log(`  ${c.dim}[${n.key}]${c.reset} ${n.data.parentItem ? `→ ${n.data.parentItem}` : ""}`);
        console.log(`  ${truncate(cleanHtml(n.data.note || ""), 200)}`);
        console.log();
      }
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── note (create) ──
program
  .command("note <item_key> <content>")
  .description("为文献创建笔记")
  .option("-t, --tags <tags...>", "笔记标签")
  .action(async (itemKey, content, opts) => {
    try {
      const parent = await zot.getItem(itemKey);
      const html = content.includes("<p>") || content.includes("<div>")
        ? content
        : content.split("\n\n").map((p: string) => `<p>${p}</p>`).join("");

      const result = await zot.createItemNote(itemKey, html, opts.tags ?? []);
      console.log(`${c.green}✓${c.reset} Note created for "${parent.data.title || itemKey}"`);
      console.log(`  Method: ${result.via}`);
      console.log(`  Key: ${result.key}`);
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── collections ──
program
  .command("collections [key]")
  .description("浏览文件夹（不传 key 显示树形列表）")
  .option("-n, --limit <n>", "最大条目数", "50")
  .action(async (key, opts) => {
    try {
      if (key) {
        const [items, col] = await Promise.all([
          zot.getCollectionItems(key, Number(opts.limit)),
          zot.getCollection(key),
        ]);
        console.log(`\n${c.bold}Collection: ${col.data.name}${c.reset} (${items.length} items)\n`);
        for (const item of items) {
          console.log(`  ${c.dim}[${item.key}]${c.reset} ${item.data.title || "Untitled"}`);
        }
        return;
      }

      const collections = await zot.getCollections();
      if (!collections.length) { console.log("No collections."); return; }

      const map = new Map(collections.map((col) => [col.key, col]));
      const tree: Record<string, string[]> = {};
      for (const col of collections) {
        const pk = col.data.parentCollection || "__root__";
        (tree[pk] ??= []).push(col.key);
      }

      function render(k: string, lvl: number): void {
        const col = map.get(k);
        if (!col) return;
        const count = col.meta?.numItems ?? 0;
        console.log(`${"  ".repeat(lvl + 1)}${c.bold}${col.data.name}${c.reset} ${c.dim}[${k}] (${count})${c.reset}`);
        for (const ck of tree[k] ?? []) render(ck, lvl + 1);
      }

      console.log(`\n${c.bold}Zotero Collections${c.reset}\n`);
      for (const k of tree["__root__"] ?? []) render(k, 0);
      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── tags ──
program
  .command("tags")
  .description("列出所有标签")
  .option("-n, --limit <n>", "最大数量")
  .action(async (opts) => {
    try {
      const tags = await zot.getTags(opts.limit ? Number(opts.limit) : undefined);
      if (!tags.length) { console.log("No tags."); return; }

      const sorted = [...tags].sort((a, b) => (b.meta?.numItems ?? 0) - (a.meta?.numItems ?? 0));
      console.log(`\n${c.bold}Zotero Tags${c.reset} (${sorted.length})\n`);
      for (const t of sorted) {
        console.log(`  ${c.cyan}${t.tag}${c.reset} ${c.dim}(${t.meta?.numItems ?? 0})${c.reset}`);
      }
      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── tag (batch) ──
program
  .command("tag <query>")
  .description("批量添加/移除标签")
  .option("-a, --add <tags...>", "添加标签")
  .option("-r, --remove <tags...>", "移除标签")
  .option("-n, --limit <n>", "最大处理数", "50")
  .action(async (query, opts) => {
    try {
      if (!opts.add?.length && !opts.remove?.length) {
        console.error("Specify --add or --remove"); process.exit(1);
      }
      const items = await zot.searchItems(query, { qmode: "titleCreatorYear", itemType: "-attachment", limit: Number(opts.limit) });
      if (!items.length) { console.log(`No items matching: ${query}`); return; }

      console.log(`\n${c.bold}Batch Tag${c.reset}: ${items.length} items matched\n`);

      if (!(await zot.hasLocalBridge())) {
        console.log(`${c.yellow}Preview only (Local Bridge plugin required for writes)${c.reset}`);
        for (const item of items) {
          console.log(`  ${c.dim}[${item.key}]${c.reset} ${item.data.title || "Untitled"}`);
        }
        return;
      }

      let updated = 0;
      for (const item of items) {
        try {
          let tags = [...(item.data.tags ?? [])];
          let changed = false;
          if (opts.add) for (const t of opts.add) {
            if (!tags.some((x) => x.tag === t)) { tags.push({ tag: t }); changed = true; }
          }
          if (opts.remove) {
            const before = tags.length;
            tags = tags.filter((t) => !opts.remove.includes(t.tag));
            if (tags.length !== before) changed = true;
          }
          if (changed) { item.data.tags = tags; await zot.updateItem(item); updated++; }
        } catch (e) {
          console.error(`  ${c.red}${item.key}: ${e instanceof Error ? e.message : e}${c.reset}`);
        }
      }
      console.log(`${c.green}✓${c.reset} Updated ${updated} / ${items.length} items`);
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── export ──
program
  .command("export <keys...>")
  .description("导出 BibTeX")
  .action(async (keys) => {
    try {
      for (const key of keys) {
        try {
          const item = await zot.getItem(key);
          console.log(await generateBibtex(item));
          console.log();
        } catch (e) {
          console.error(`% Error exporting ${key}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── libraries ──
program
  .command("libraries")
  .description("列出所有 Zotero 库")
  .action(async () => {
    try {
      const libs = localDb.getLibraries();

      console.log(`\n${c.bold}Zotero Libraries${c.reset}\n`);
      for (const lib of libs) {
        if (lib.type === "user") {
          console.log(`  ${c.cyan}User Library${c.reset} (ID: ${lib.libraryID}) — ${lib.itemCount} items`);
        } else if (lib.type === "group" && lib.groupName) {
          console.log(`  ${c.magenta}Group: ${lib.groupName}${c.reset} (ID: ${lib.groupID}) — ${lib.itemCount} items`);
        }
      }

      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── status ──
program
  .command("status")
  .description("系统状态检查")
  .action(async () => {
    try {
      console.log(`\n${c.bold}Zotero MCP Status${c.reset}\n`);

      // Data dir
      try {
        const dataDir = findZoteroDataDir();
        console.log(`  ${c.green}✓${c.reset} Zotero Data: ${dataDir}`);
      } catch {
        console.log(`  ${c.red}✗${c.reset} Zotero Data: not found`);
      }

      // Local API
      try {
        await zot.getItems({ limit: 1 });
        console.log(`  ${c.green}✓${c.reset} Local API: http://127.0.0.1:23119`);
      } catch {
        console.log(`  ${c.yellow}⚠${c.reset} Local API: not running (SQLite fallback active)`);
      }

      // Local Bridge
      const bridgeReady = await zot.hasLocalBridge();
      console.log(`  ${bridgeReady ? `${c.green}✓` : `${c.dim}-`}${c.reset} Local Bridge: ${bridgeReady ? "loaded" : "not loaded"}`);

      // PaddleOCR
      const ocrUrl = process.env.PADDLEOCR_API_URL || "https://32h7fan0h9tfqep6.aistudio-app.com/layout-parsing";
      console.log(`  ${c.dim}-${c.reset} PaddleOCR: ${ocrUrl}`);

      // Libraries
      try {
        const libs = localDb.getLibraries();
        const totalItems = libs.reduce((sum, l) => sum + l.itemCount, 0);
        console.log(`  ${c.green}✓${c.reset} Libraries: ${libs.length} (${totalItems} items total)`);
      } catch {
        console.log(`  ${c.red}✗${c.reset} Libraries: cannot read`);
      }

      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
    }
  });

// ── add (DOI import) ──
program
  .command("add <dois...>")
  .description("通过 DOI 导入论文到 Zotero (含 OA PDF 自动下载)")
  .option("-c, --collection <key>", "添加到指定文件夹")
  .option("-t, --tags <tags...>", "添加标签")
  .option("--no-pdf", "不下载 PDF")
  .action(async (dois, opts) => {
    try {
      for (const rawDoi of dois) {
        const m = rawDoi.match(/10\.\d{4,}\/[^\s]+/);
        const doi = m ? m[0] : rawDoi;

        console.log(`\n${c.bold}Importing: ${doi}${c.reset}`);

        // 1. CrossRef metadata
        const meta = await getCrossRefMeta(doi);
        console.log(`  ${c.green}✓${c.reset} ${meta.title}`);
        console.log(`    ${c.dim}${meta.authors.map((a) => a.lastName || a.name).join(", ")} · ${meta.year || "n.d."} · ${meta.itemType}${c.reset}`);

        // 2. Create Zotero item
        const payload = metaToZoteroPayload(meta, opts.collection);
        if (opts.tags?.length) {
          payload.tags = opts.tags.map((t: string) => ({ tag: t }));
        }
        const itemKey = await zot.createItem(payload);
        console.log(`  ${c.green}✓${c.reset} Zotero item: [${itemKey}]`);

        // 3. Try OA PDF
        if (opts.pdf !== false) {
          const src = await findOaPdf(doi);
          if (src) {
            console.log(`  ${c.yellow}⬇${c.reset} OA PDF (${src.source}): ${src.url.slice(0, 60)}...`);
            const tmpDir = join("/tmp", "zotero-mcp-pdf");
            const filename = `${doi.replace(/[/\\:]/g, "_")}.pdf`;
            const dl = await downloadPdf(src.url, tmpDir, filename);
            if (dl) {
              try {
                await zot.uploadAttachment(itemKey, dl.path, "application/pdf", filename);
                console.log(`  ${c.green}✓${c.reset} PDF attached (${(dl.size / 1024).toFixed(0)} KB)`);
              } catch {
                try {
                  await zot.createLinkedUrlAttachment(itemKey, src.url, `${meta.title}.pdf`);
                  console.log(`  ${c.cyan}↗${c.reset} PDF linked as URL`);
                } catch { console.log(`  ${c.red}✗${c.reset} PDF attach failed`); }
              }
            } else {
              try {
                await zot.createLinkedUrlAttachment(itemKey, src.url, `${meta.title}.pdf`);
                console.log(`  ${c.cyan}↗${c.reset} PDF linked (download blocked by CDN)`);
              } catch { console.log(`  ${c.red}✗${c.reset} PDF unavailable`); }
            }
          } else {
            console.log(`  ${c.dim}-${c.reset} No OA PDF found`);
          }
        }
      }
      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── read-file ──
program
  .command("read-file <key>")
  .description("读取条目下已保存的 MD/TXT 文本文件")
  .option("-s, --source <src>", "指定来源 (auto|md|txt|index)", "auto")
  .option("-n, --max <n>", "最大字符数", "5000")
  .action(async (key, opts) => {
    try {
      const item = await zot.getItem(key);
      const children = await zot.getItemChildren(key);
      const att = zot.findBestAttachment(children);
      if (!att) { console.error(`${c.red}No attachment${c.reset}`); process.exit(1); }

      const files = resolveItemFiles(att.key, typeof att.path === "string" ? att.path : undefined);
      let text: string | null = null;
      let src = "";

      if ((opts.source === "auto" || opts.source === "md") && files.mdPath) {
        text = readFileSync(files.mdPath, "utf-8"); src = "md";
      }
      if (!text && (opts.source === "auto" || opts.source === "txt") && files.txtPath) {
        text = readFileSync(files.txtPath, "utf-8"); src = "txt";
      }

      if (!text) {
        console.log(`${c.yellow}⚠ 无可读全文${c.reset}`);
        if (files.pdfPath) console.log(`PDF: ${files.pdfPath}\n运行: zotero ocr ${key} 或使用 MCP zotero_texts 保存 MD/TXT`);
        return;
      }

      const max = Number(opts.max);
      const truncated = text.length > max;
      console.log(`\n${c.bold}${item.data.title || "Untitled"}${c.reset}`);
      console.log(`${c.dim}Source: ${src} | ${text.length.toLocaleString()} chars${truncated ? ` (showing first ${max})` : ""}${c.reset}\n`);
      console.log(truncated ? text.slice(0, max) + "\n\n... [truncated]" : text);
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

// ── duplicates ──
program
  .command("duplicates")
  .description("检测重复文献")
  .option("-n, --limit <n>", "扫描条目数", "100")
  .option("-c, --collection <key>", "限定文件夹")
  .action(async (opts) => {
    try {
      let items;
      if (opts.collection) {
        items = await zot.getCollectionItems(opts.collection, Number(opts.limit));
      } else {
        items = await zot.getItems({ limit: Number(opts.limit), sort: "title", direction: "asc", itemType: "-attachment" });
      }

      const doiGroups = new Map<string, typeof items>();
      const titleGroups = new Map<string, typeof items>();

      for (const item of items) {
        if (item.data.itemType === "note" || item.data.itemType === "attachment") continue;
        const doi = item.data.DOI?.toLowerCase().trim();
        if (doi) { const g = doiGroups.get(doi) ?? []; g.push(item); doiGroups.set(doi, g); }
        const title = (item.data.title || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
        if (title.length > 10) { const g = titleGroups.get(title) ?? []; g.push(item); titleGroups.set(title, g); }
      }

      let found = 0;
      console.log(`\n${c.bold}Duplicate Check${c.reset} (${items.length} items scanned)\n`);

      for (const [doi, group] of doiGroups) {
        if (group.length < 2) continue;
        found++;
        console.log(`  ${c.red}DOI: ${doi}${c.reset}`);
        for (const it of group) console.log(`    ${c.dim}[${it.key}]${c.reset} ${it.data.title || "Untitled"}`);
        console.log();
      }
      for (const [, group] of titleGroups) {
        if (group.length < 2) continue;
        const keys = group.map((i) => i.key).sort().join(",");
        // Skip if already found by DOI
        const doiFound = [...doiGroups.values()].some((g) => g.length >= 2 && g.map((i) => i.key).sort().join(",") === keys);
        if (doiFound) continue;
        found++;
        console.log(`  ${c.yellow}Title match${c.reset}`);
        for (const it of group) console.log(`    ${c.dim}[${it.key}]${c.reset} ${it.data.title || "Untitled"}`);
        console.log();
      }

      if (!found) console.log(`  ${c.green}✓${c.reset} No duplicates found`);
      console.log();
    } catch (e) {
      console.error(`${c.red}Error: ${e instanceof Error ? e.message : e}${c.reset}`);
      process.exit(1);
    }
  });

program.parse();
