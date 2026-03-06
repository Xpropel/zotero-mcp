import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { ZoteroCreator } from "./types.js";

export function formatCreators(creators: ZoteroCreator[]): string {
  if (!creators?.length) return "No authors listed";
  const names = creators
    .map((c) => {
      if (c.firstName && c.lastName) return `${c.lastName}, ${c.firstName}`;
      return c.name || c.lastName || "";
    })
    .filter(Boolean);
  return names.length > 0 ? names.join("; ") : "No authors listed";
}

export function cleanHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&hellip;/g, "\u2026")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let _dataDir: string | null = null;

export function findZoteroDataDir(): string {
  if (_dataDir) return _dataDir;

  const envDir = process.env.ZOTERO_DATA_DIR;
  if (envDir && existsSync(join(envDir, "zotero.sqlite"))) {
    _dataDir = envDir;
    return envDir;
  }

  const home = homedir();
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(join(home, "Zotero"));
    candidates.push(join(home, "Library", "Application Support", "Zotero", "Profiles"));
  } else if (platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    candidates.push(join(home, "Zotero"));
    candidates.push(join(appData, "Zotero", "Zotero"));
  } else {
    candidates.push(join(home, "Zotero"));
    candidates.push(join(home, ".zotero", "zotero"));
  }

  for (const dir of candidates) {
    if (existsSync(join(dir, "zotero.sqlite"))) {
      _dataDir = dir;
      return dir;
    }
  }

  const checked = envDir ? [`$ZOTERO_DATA_DIR (${envDir})`, ...candidates] : candidates;
  throw new Error(`Zotero data directory not found. Checked: ${checked.join(", ")}. Set ZOTERO_DATA_DIR to override.`);
}

export function findZoteroDb(): string {
  return join(findZoteroDataDir(), "zotero.sqlite");
}

export function resolveAttachmentPath(
  attachmentKey: string,
  zoteroPath?: string
): string | null {
  const attachDir = join(findZoteroDataDir(), "storage", attachmentKey);

  if (zoteroPath?.startsWith("storage:")) {
    const resolved = join(attachDir, zoteroPath.slice("storage:".length));
    return existsSync(resolved) ? resolved : null;
  }

  if (!existsSync(attachDir)) return null;
  try {
    const files = readdirSync(attachDir);
    const pick =
      files.find((f) => f.toLowerCase().endsWith(".pdf")) ??
      files.find((f) => f.toLowerCase().endsWith(".epub")) ??
      files[0];
    return pick ? join(attachDir, pick) : null;
  } catch {
    return null;
  }
}

export function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + "...";
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
