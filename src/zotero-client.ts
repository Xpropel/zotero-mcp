import type {
  ZoteroItem,
  ZoteroCollection,
  ZoteroFulltext,
  AttachmentInfo,
  ActiveLibrary,
} from "./types.js";
import { resolveAttachmentPath } from "./utils.js";

const LOCAL_PORT = 23119;
const LOCAL = `http://localhost:${LOCAL_PORT}`;
const WEB = "https://api.zotero.org";
const TIMEOUT = 15_000;
const BBT_TIMEOUT = 5_000;

let activeLib: ActiveLibrary = { libraryId: "0", libraryType: "user" };

const webKey = process.env.ZOTERO_API_KEY || "";
const webLibId = process.env.ZOTERO_LIBRARY_ID || "";
const webLibType = process.env.ZOTERO_LIBRARY_TYPE || "user";

export const hasWebApi = () => !!(webKey && webLibId);

export function setActiveLibrary(id: string, type: string): void {
  activeLib = { libraryId: id, libraryType: type };
}
export function clearActiveLibrary(): void {
  activeLib = { libraryId: "0", libraryType: "user" };
}

function localBase(): string {
  const prefix = activeLib.libraryType === "group" ? "groups" : "users";
  return `${LOCAL}/api/${prefix}/${activeLib.libraryId}`;
}
function webBase(): string {
  const prefix = webLibType === "group" ? "groups" : "users";
  return `${WEB}/${prefix}/${webLibId}`;
}

// ── HTTP helpers ──

function fetchT(url: string | URL, init?: RequestInit, ms = TIMEOUT): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}

async function localGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${localBase()}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetchT(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Zotero API ${res.status}: ${body || res.statusText}`);
  }
  const data = await res.json();
  if (data == null) throw new Error(`Zotero API empty response for ${path}`);
  return data as T;
}

const webHeaders = () => ({
  "Content-Type": "application/json",
  "Zotero-API-Key": webKey,
  "Zotero-API-Version": "3",
});

async function webPost(path: string, body: unknown): Promise<unknown> {
  if (!hasWebApi()) throw new Error("Zotero Web API not configured (set ZOTERO_API_KEY + ZOTERO_LIBRARY_ID)");
  const res = await fetchT(`${webBase()}${path}`, {
    method: "POST",
    headers: webHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Zotero Web API POST ${res.status}: ${t || res.statusText}`);
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : {};
}

async function webPut(path: string, body: unknown, version: number): Promise<void> {
  if (!hasWebApi()) throw new Error("Zotero Web API not configured (set ZOTERO_API_KEY + ZOTERO_LIBRARY_ID)");
  const res = await fetchT(`${webBase()}${path}`, {
    method: "PUT",
    headers: { ...webHeaders(), "If-Unmodified-Since-Version": String(version) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Zotero Web API PUT ${res.status}: ${t || res.statusText}`);
  }
}

async function webGet<T>(path: string): Promise<T> {
  if (!hasWebApi()) throw new Error("Zotero Web API not configured (set ZOTERO_API_KEY + ZOTERO_LIBRARY_ID)");
  const res = await fetchT(`${webBase()}${path}`, { headers: { ...webHeaders(), Accept: "application/json" } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Zotero Web API GET ${res.status}: ${t || res.statusText}`);
  }
  return (await res.json()) as T;
}

function extractCreatedKey(result: unknown): string {
  const r = result as {
    successful?: Record<string, { key: string }>;
    success?: Record<string, string>;
  };
  if (r.successful) {
    const first = Object.values(r.successful)[0];
    if (first?.key) return first.key;
  }
  if (r.success) {
    const first = Object.values(r.success)[0];
    if (first) return first;
  }
  return "created";
}

// ── Read: items ──

export async function searchItems(
  query: string,
  opts: { qmode?: string; itemType?: string; limit?: number; tag?: string[]; sort?: string; direction?: string } = {}
): Promise<ZoteroItem[]> {
  const p: Record<string, string> = { q: query };
  if (opts.qmode) p.qmode = opts.qmode;
  if (opts.itemType) p.itemType = opts.itemType;
  if (opts.limit !== undefined) p.limit = String(opts.limit);
  if (opts.sort) p.sort = opts.sort;
  if (opts.direction) p.direction = opts.direction;
  if (opts.tag?.length) p.tag = opts.tag.join(" || ");
  return localGet<ZoteroItem[]>("/items", p);
}

export const getItem = (key: string) =>
  localGet<ZoteroItem>(`/items/${encodeURIComponent(key)}`);

export async function getItems(opts: {
  limit?: number; start?: number; sort?: string; direction?: string; itemType?: string;
}): Promise<ZoteroItem[]> {
  const p: Record<string, string> = {};
  if (opts.limit !== undefined) p.limit = String(opts.limit);
  if (opts.start !== undefined) p.start = String(opts.start);
  if (opts.sort) p.sort = opts.sort;
  if (opts.direction) p.direction = opts.direction;
  if (opts.itemType) p.itemType = opts.itemType;
  return localGet<ZoteroItem[]>("/items", p);
}

export const getItemChildren = (key: string) =>
  localGet<ZoteroItem[]>(`/items/${encodeURIComponent(key)}/children`);

export async function getItemFulltext(key: string): Promise<ZoteroFulltext | null> {
  try { return await localGet<ZoteroFulltext>(`/items/${encodeURIComponent(key)}/fulltext`); }
  catch { return null; }
}

// ── Read: collections / tags ──

export const getCollections = (limit?: number) =>
  localGet<ZoteroCollection[]>("/collections", limit !== undefined ? { limit: String(limit) } : {});

export const getCollection = (key: string) =>
  localGet<ZoteroCollection>(`/collections/${encodeURIComponent(key)}`);

export const getCollectionItems = (key: string, limit?: number) =>
  localGet<ZoteroItem[]>(
    `/collections/${encodeURIComponent(key)}/items`,
    limit !== undefined ? { limit: String(limit) } : {}
  );

export const getTags = (limit?: number) =>
  localGet<Array<{ tag: string; meta: { numItems: number } }>>(
    "/tags",
    limit !== undefined ? { limit: String(limit) } : {}
  );

// ── Attachments ──

export function findBestAttachment(children: ZoteroItem[]): AttachmentInfo | null {
  const atts = children.filter((c) => c.data.itemType === "attachment");
  const pick =
    atts.find((a) => a.data.contentType === "application/pdf") ??
    atts.find((a) => a.data.contentType?.startsWith("text/html")) ??
    atts[0];
  if (!pick) return null;

  const rawPath = pick.data.path;
  const filePath = resolveAttachmentPath(pick.key, typeof rawPath === "string" ? rawPath : undefined);
  return {
    key: pick.key,
    title: pick.data.title || "Untitled",
    filename: pick.data.filename || "",
    contentType: pick.data.contentType || "",
    path: filePath ?? undefined,
  };
}

// ── Write: notes ──

export async function createItemNote(parentKey: string, noteHtml: string, tags: string[] = []): Promise<string> {
  const noteData = {
    itemType: "note",
    parentItem: parentKey,
    note: noteHtml,
    tags: tags.map((t) => ({ tag: t })),
  };

  if (hasWebApi()) return extractCreatedKey(await webPost("/items", [noteData]));

  // Connector fallback (standalone note)
  const res = await fetchT(`${LOCAL}/connector/saveItems`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ ...noteData, tags }], uri: "about:blank" }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Connector saveItems ${res.status}: ${t || res.statusText}`);
  }
  return "created-via-connector";
}

// ── Write: annotations ──

export async function createAnnotationItem(attachmentKey: string, annotation: Record<string, unknown>): Promise<string> {
  if (!hasWebApi()) {
    throw new Error("Creating annotations requires the Zotero Web API.\nSet ZOTERO_API_KEY and ZOTERO_LIBRARY_ID.");
  }
  return extractCreatedKey(
    await webPost("/items", [{ itemType: "annotation", parentItem: attachmentKey, ...annotation }])
  );
}

// ── Write: update item ──

export async function updateItem(item: ZoteroItem): Promise<void> {
  const path = `/items/${encodeURIComponent(item.key)}`;
  const current = await webGet<ZoteroItem>(path);
  await webPut(path, { ...item.data, version: current.version }, current.version);
}

// ── Better BibTeX ──

async function bbtRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetchT(
      `${LOCAL}/better-bibtex/json-rpc`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      },
      BBT_TIMEOUT
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: T };
    return data.result ?? null;
  } catch {
    return null;
  }
}

export const betterBibtexExport = (key: string) =>
  bbtRpc<string>("item.export", [[key], "betterbibtex"]);

export const betterBibtexGetAnnotations = (key: string) =>
  bbtRpc<unknown[]>("item.annotations", [[key]]);
