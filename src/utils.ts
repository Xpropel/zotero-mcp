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
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
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
  const candidates = [join(homedir(), "Zotero")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "zotero.sqlite"))) {
      _dataDir = dir;
      return dir;
    }
  }
  throw new Error(`Zotero data directory not found. Checked: ${candidates.join(", ")}`);
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
