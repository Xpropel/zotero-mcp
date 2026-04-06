import type {
  ZoteroItem,
  ZoteroCollection,
  ZoteroFulltext,
  AttachmentInfo,
  ActiveLibrary,
} from "./types.js";
import { resolveAttachmentPath } from "./utils.js";
import * as sql from "./sql-fallback.js";

const LOCAL_PORT = 23119;
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const WEB = "https://api.zotero.org";
const TIMEOUT = 15_000;
const BBT_TIMEOUT = 5_000;

let activeLib: ActiveLibrary = { libraryId: "0", libraryType: "user" };

const webKey = process.env.ZOTERO_API_KEY || "";
const webLibId = process.env.ZOTERO_LIBRARY_ID || "";
const webLibType = process.env.ZOTERO_LIBRARY_TYPE || "user";

export function hasWebApi(): boolean {
  return !!(webKey && webLibId);
}

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

/** When local HTTP API is down, read from zotero.sqlite (set ZOTERO_DISABLE_SQLITE_FALLBACK=1 to disable). */
async function tryLocalOrSql<T>(apiCall: () => Promise<T>, sqlFallback: () => T): Promise<T> {
  if (process.env.ZOTERO_FORCE_SQLITE === "1") return sqlFallback();
  try {
    return await apiCall();
  } catch (e) {
    if (process.env.ZOTERO_DISABLE_SQLITE_FALLBACK === "1") throw e;
    return sqlFallback();
  }
}

function webHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Zotero-API-Key": webKey,
    "Zotero-API-Version": "3",
  };
}

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

async function webPatch(path: string, body: unknown, version: number): Promise<void> {
  if (!hasWebApi()) throw new Error("Zotero Web API not configured (set ZOTERO_API_KEY + ZOTERO_LIBRARY_ID)");
  const res = await fetchT(`${webBase()}${path}`, {
    method: "PATCH",
    headers: { ...webHeaders(), "If-Unmodified-Since-Version": String(version) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Zotero Web API PATCH ${res.status}: ${t || res.statusText}`);
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

/** How `zotero_create_note` chooses between local Connector and Web API. */
export type CreateNoteResult = {
             key: string;
             via: "connector" | "web";
             /** Present when using Connector: Zotero ignores `parentItem` on standalone notes. */
             connectorParentIgnored?: boolean;
           };

type NotesWriteMode = "auto" | "local" | "web";

function getNotesWriteMode(): NotesWriteMode {
  const v = (process.env.ZOTERO_NOTES_WRITE_MODE || "auto").toLowerCase();
  if (v === "local" || v === "web" || v === "auto") return v;
  return "auto";
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
  return tryLocalOrSql(
    () => localGet<ZoteroItem[]>("/items", p),
    () => sql.sqlSearchItems(query, opts)
  );
}

export async function getItem(key: string): Promise<ZoteroItem> {
  return tryLocalOrSql(
    () => localGet<ZoteroItem>(`/items/${encodeURIComponent(key)}`),
    () => {
      const item = sql.sqlGetItemByKey(key);
      if (!item) throw new Error(`Item not found: ${key}`);
      return item;
    }
  );
}

export async function getItems(opts: {
  limit?: number; start?: number; sort?: string; direction?: string; itemType?: string;
}): Promise<ZoteroItem[]> {
  const p: Record<string, string> = {};
  if (opts.limit !== undefined) p.limit = String(opts.limit);
  if (opts.start !== undefined) p.start = String(opts.start);
  if (opts.sort) p.sort = opts.sort;
  if (opts.direction) p.direction = opts.direction;
  if (opts.itemType) p.itemType = opts.itemType;
  return tryLocalOrSql(
    () => localGet<ZoteroItem[]>("/items", p),
    () => sql.sqlGetItems(opts)
  );
}

export async function getItemChildren(key: string): Promise<ZoteroItem[]> {
  return tryLocalOrSql(
    () => localGet<ZoteroItem[]>(`/items/${encodeURIComponent(key)}/children`),
    () => sql.sqlGetItemChildren(key)
  );
}

export async function getItemFulltext(key: string): Promise<ZoteroFulltext | null> {
  try { return await localGet<ZoteroFulltext>(`/items/${encodeURIComponent(key)}/fulltext`); }
  catch { return null; }
}

// ── Read: collections / tags ──

export async function getCollections(limit?: number): Promise<ZoteroCollection[]> {
  return tryLocalOrSql(
    () => localGet<ZoteroCollection[]>("/collections", limit !== undefined ? { limit: String(limit) } : {}),
    () => {
      const all = sql.sqlGetCollections();
      return limit !== undefined ? all.slice(0, limit) : all;
    }
  );
}

export async function getCollection(key: string): Promise<ZoteroCollection> {
  return tryLocalOrSql(
    () => localGet<ZoteroCollection>(`/collections/${encodeURIComponent(key)}`),
    () => {
      const c = sql.sqlGetCollectionByKey(key);
      if (!c) throw new Error(`Collection not found: ${key}`);
      return c;
    }
  );
}

export async function getCollectionItems(key: string, limit?: number): Promise<ZoteroItem[]> {
  return tryLocalOrSql(
    () =>
      localGet<ZoteroItem[]>(
        `/collections/${encodeURIComponent(key)}/items`,
        limit !== undefined ? { limit: String(limit) } : {}
      ),
    () => sql.sqlGetCollectionItems(key, limit)
  );
}

export async function getTags(limit?: number): Promise<Array<{ tag: string; meta: { numItems: number } }>> {
  return tryLocalOrSql(
    () =>
      localGet<Array<{ tag: string; meta: { numItems: number } }>>(
        "/tags",
        limit !== undefined ? { limit: String(limit) } : {}
      ),
    () => sql.sqlGetTags(limit)
  );
}

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

export async function createItemNote(
  parentKey: string,
  noteHtml: string,
  tags: string[] = []
): Promise<CreateNoteResult> {
  const noteData = {
    itemType: "note",
    parentItem: parentKey,
    note: noteHtml,
    tags: tags.map((t) => ({ tag: t })),
  };

  async function postConnector(): Promise<Response> {
    return fetchT(`${LOCAL}/connector/saveItems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ ...noteData, tags }], uri: "about:blank" }),
    });
  }

  const mode = getNotesWriteMode();

  if (mode === "web") {
    if (!hasWebApi()) {
      throw new Error(
        "ZOTERO_NOTES_WRITE_MODE=web requires ZOTERO_API_KEY and ZOTERO_LIBRARY_ID"
      );
    }
    const key = extractCreatedKey(await webPost("/items", [noteData]));
    return { key, via: "web" };
  }

  if (mode === "local") {
    const res = await postConnector();
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(
        `ZOTERO_NOTES_WRITE_MODE=local: connector failed (HTTP ${res.status}). Is Zotero running with connector enabled? ${t || res.statusText}`
      );
    }
    // Zotero.Translate.ItemSaver._saveNote() does not read `parentItem` from JSON for a standalone
    // note; only an explicit parentItemID (child notes array) works. Connector saveItems uses that path.
    return {
      key: "created-via-connector",
      via: "connector",
      connectorParentIgnored: true,
    };
  }

  // auto: use Web API when available so `parentItem` is honored (child note under the entry).
  // Connector cannot attach standalone notes to a parent — they land in the save-target collection.
  if (hasWebApi()) {
    const key = extractCreatedKey(await webPost("/items", [noteData]));
    return { key, via: "web" };
  }

  const res = await postConnector();
  if (res.ok) {
    return {
      key: "created-via-connector",
      via: "connector",
      connectorParentIgnored: true,
    };
  }

  const t = await res.text().catch(() => "");
  throw new Error(
    `Connector saveItems ${res.status}: ${t || res.statusText}. Start Zotero, or set ZOTERO_API_KEY + ZOTERO_LIBRARY_ID (or ZOTERO_NOTES_WRITE_MODE=web).`
  );
}

// ── Write: create item ──

export async function createItem(payload: Record<string, unknown>): Promise<string> {
  if (!hasWebApi()) {
    throw new Error("Creating items requires the Zotero Web API.\nSet ZOTERO_API_KEY and ZOTERO_LIBRARY_ID.");
  }
  return extractCreatedKey(await webPost("/items", [payload]));
}

// ── Write: attachments ──

export async function uploadAttachment(
  parentKey: string,
  filePath: string,
  contentType: string,
  filename: string
): Promise<string> {
  if (!hasWebApi()) throw new Error("Uploading attachments requires Zotero Web API.");

  // Step 1: Create attachment item
  const attPayload = {
    itemType: "attachment",
    parentItem: parentKey,
    linkMode: "imported_file",
    title: filename,
    contentType,
    filename,
  };
  const attKey = extractCreatedKey(await webPost("/items", [attPayload]));

  // Step 2: Upload file content
  const { readFileSync, statSync } = await import("node:fs");
  const fileContent = readFileSync(filePath);
  const md5 = await computeMd5(fileContent);
  const size = statSync(filePath).size;

  // Get upload authorization
  const authRes = await fetchT(`${webBase()}/items/${attKey}/file`, {
    method: "POST",
    headers: {
      ...webHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      "If-None-Match": "*",
    },
    body: `md5=${md5}&filename=${encodeURIComponent(filename)}&filesize=${size}&mtime=${Date.now()}`,
  });

  if (!authRes.ok) {
    const t = await authRes.text().catch(() => "");
    throw new Error(`Upload auth failed ${authRes.status}: ${t}`);
  }

  const auth = (await authRes.json()) as { exists?: boolean; url?: string; contentType?: string; prefix?: string; suffix?: string; uploadKey?: string };
  if (auth.exists) return attKey; // File already exists

  if (auth.url) {
    // Upload file
    const body = Buffer.concat([
      Buffer.from(auth.prefix || "", "utf-8"),
      fileContent,
      Buffer.from(auth.suffix || "", "utf-8"),
    ]);
    const upRes = await fetchT(auth.url, {
      method: "POST",
      headers: { "Content-Type": auth.contentType || "application/octet-stream" },
      body,
    }, 60_000);

    if (!upRes.ok) throw new Error(`File upload failed: ${upRes.status}`);

    // Register upload
    await fetchT(`${webBase()}/items/${attKey}/file`, {
      method: "POST",
      headers: {
        ...webHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      body: `upload=${auth.uploadKey}`,
    });
  }

  return attKey;
}

async function computeMd5(data: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(data).digest("hex");
}

export async function createLinkedUrlAttachment(
  parentKey: string,
  url: string,
  title: string
): Promise<string> {
  if (!hasWebApi()) throw new Error("Creating attachments requires Zotero Web API.");
  return extractCreatedKey(
    await webPost("/items", [{
      itemType: "attachment",
      parentItem: parentKey,
      linkMode: "linked_url",
      title,
      url,
      contentType: "application/pdf",
    }])
  );
}

// ── Write: collections ──

export async function createCollection(name: string, parentKey?: string): Promise<string> {
  if (!hasWebApi()) throw new Error("Creating collections requires Zotero Web API.");
  const payload: Record<string, unknown> = { name };
  if (parentKey) payload.parentCollection = parentKey;
  const result = await webPost("/collections", [payload]);
  return extractCreatedKey(result);
}

export async function addToCollection(collectionKey: string, itemKeys: string[]): Promise<void> {
  // Read each item, add collection, patch
  for (const key of itemKeys) {
    const item = await webGet<ZoteroItem>(`/items/${encodeURIComponent(key)}`);
    const collections = new Set<string>(item.data.collections || []);
    if (collections.has(collectionKey)) continue;
    collections.add(collectionKey);
    await webPatch(`/items/${encodeURIComponent(key)}`, { collections: [...collections] }, item.version);
  }
}

export async function removeFromCollection(collectionKey: string, itemKeys: string[]): Promise<void> {
  for (const key of itemKeys) {
    const item = await webGet<ZoteroItem>(`/items/${encodeURIComponent(key)}`);
    const collections = (item.data.collections || []).filter((c: string) => c !== collectionKey);
    await webPatch(`/items/${encodeURIComponent(key)}`, { collections }, item.version);
  }
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
  const { version: _v, ...dataWithoutVersion } = item.data;
  await webPatch(path, dataWithoutVersion, current.version);
}

export async function updateItemFields(
  key: string,
  fields: Record<string, unknown>
): Promise<void> {
  if (!hasWebApi()) throw new Error("Updating items requires Zotero Web API.");
  const path = `/items/${encodeURIComponent(key)}`;
  const current = await webGet<ZoteroItem>(path);
  await webPatch(path, fields, current.version);
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

export async function betterBibtexExport(key: string): Promise<string | null> {
  return bbtRpc<string>("item.export", [[key], "betterbibtex"]);
}

export async function betterBibtexGetAnnotations(key: string): Promise<unknown[] | null> {
  return bbtRpc<unknown[]>("item.annotations", [[key]]);
}
