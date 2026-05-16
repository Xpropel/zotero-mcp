import type {
  ZoteroItem,
  ZoteroCollection,
  ZoteroFulltext,
  AttachmentInfo,
  ActiveLibrary,
  RuntimeCapabilities,
} from "./types.js";
import { resolveAttachmentPath } from "./utils.js";
import * as sql from "./sql-fallback.js";
import * as bridge from "./local-bridge.js";

const LOCAL_PORT = 23119;
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const TIMEOUT = 15_000;
const BBT_TIMEOUT = 5_000;

let activeLib: ActiveLibrary = { libraryId: "0", libraryType: "user" };

export async function hasLocalBridge(): Promise<boolean> {
  return bridge.hasBridge();
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

/** How local bridge note creation reports writes. */
export type CreateNoteResult = {
  key: string;
  via: "bridge";
};

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

export function listAttachmentsFromChildren(children: ZoteroItem[]): AttachmentInfo[] {
  return children
    .filter((c) => c.data.itemType === "attachment")
    .map((att) => {
      const rawPath = att.data.path;
      const filePath = resolveAttachmentPath(att.key, typeof rawPath === "string" ? rawPath : undefined);
      return {
        key: att.key,
        title: att.data.title || "Untitled",
        filename: att.data.filename || "",
        contentType: att.data.contentType || "",
        path: filePath ?? undefined,
      };
    });
}

export async function getItemAttachments(parentKey: string): Promise<AttachmentInfo[]> {
  return listAttachmentsFromChildren(await getItemChildren(parentKey));
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
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>("/items/create", { item: noteData }, activeLib);
  return { key: created.key, via: "bridge" };
}

export async function updateNote(noteKey: string, noteHtml: string, tags?: string[]): Promise<void> {
  const fields: Record<string, unknown> = { note: noteHtml };
  if (tags) fields.tags = tags.map((tag) => ({ tag }));
  await updateItemFields(noteKey, fields);
}

export async function appendToNote(noteKey: string, noteHtml: string): Promise<void> {
  const note = await getItem(noteKey);
  if (note.data.itemType !== "note") throw new Error(`Item is not a note: ${noteKey}`);
  const current = typeof note.data.note === "string" ? note.data.note : "";
  await updateItemFields(noteKey, { note: current + noteHtml });
}

// ── Write: create item ──

export async function createItem(payload: Record<string, unknown>): Promise<string> {
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>("/items/create", { item: payload }, activeLib);
  return created.key;
}

export async function createItems(payloads: Array<Record<string, unknown>>): Promise<string[]> {
  const keys: string[] = [];
  for (const payload of payloads) {
    keys.push(await createItem(payload));
  }
  return keys;
}

// ── Write: attachments ──

export async function uploadAttachment(
  parentKey: string,
  filePath: string,
  contentType: string,
  title: string
): Promise<string> {
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>("/attachments/import-file", {
    parentKey,
    filePath,
    title,
    contentType,
  }, activeLib);
  return created.key;
}

export async function linkLocalFileAttachment(
  parentKey: string,
  filePath: string,
  contentType: string,
  title: string
): Promise<string> {
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>("/attachments/link-file", {
    parentKey,
    filePath,
    title,
    contentType,
  }, activeLib);
  return created.key;
}

export async function createLinkedUrlAttachment(
  parentKey: string,
  url: string,
  title: string,
  contentType = "application/pdf"
): Promise<string> {
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>("/attachments/link-url", {
    parentKey,
    url,
    title,
    contentType,
  }, activeLib);
  return created.key;
}

export async function updateAttachmentFields(
  key: string,
  fields: { title?: string; tags?: string[] }
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.tags !== undefined) patch.tags = fields.tags.map((tag) => ({ tag }));
  if (!Object.keys(patch).length) throw new Error("No attachment fields to update");
  await updateItemFields(key, patch);
}

// ── Write: collections ──

export async function createCollection(name: string, parentKey?: string): Promise<string> {
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>(
    "/collections/create",
    { name, parentKey },
    activeLib
  );
  return created.key;
}

export async function updateCollectionFields(
  key: string,
  fields: { name?: string; parentCollection?: string | false }
): Promise<void> {
  await bridge.bridgePost("/collections/update", { collectionKey: key, fields }, activeLib);
}

export async function deleteCollection(key: string): Promise<void> {
  await bridge.bridgePost("/collections/delete", { collectionKey: key }, activeLib);
}

export async function addToCollection(collectionKey: string, itemKeys: string[]): Promise<void> {
  await bridge.bridgePost("/collections/add-items", { collectionKey, itemKeys }, activeLib);
}

export async function removeFromCollection(collectionKey: string, itemKeys: string[]): Promise<void> {
  await bridge.bridgePost("/collections/remove-items", { collectionKey, itemKeys }, activeLib);
}

// ── Write: annotations ──

export async function createAnnotationItem(attachmentKey: string, annotation: Record<string, unknown>): Promise<string> {
  const created = await bridge.bridgePost<bridge.BridgeObjectResult>(
    "/items/create",
    { item: { itemType: "annotation", parentItem: attachmentKey, ...annotation } },
    activeLib
  );
  return created.key;
}

// ── Write: update item ──

export async function updateItem(item: ZoteroItem): Promise<void> {
  const { version: _v, ...dataWithoutVersion } = item.data;
  await bridge.bridgePost("/items/update", { itemKey: item.key, fields: dataWithoutVersion }, activeLib);
}

export async function updateItemFields(
  key: string,
  fields: Record<string, unknown>
): Promise<void> {
  await bridge.bridgePost("/items/update", { itemKey: key, fields }, activeLib);
}

export async function deleteItem(key: string, permanent = false): Promise<void> {
  await bridge.bridgePost("/items/delete", { itemKeys: [key], permanent }, activeLib);
}

export async function getItemsByTag(tag: string, limit = 500): Promise<ZoteroItem[]> {
  return localGet<ZoteroItem[]>("/items", { tag, limit: String(limit) });
}

export async function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  const caps: RuntimeCapabilities = {
    localApiRead: false,
    localApiWrite: false,
    localConnector: false,
    localBridge: false,
    sqliteFallback: false,
  };

  try {
    sql.sqlGetItems({ limit: 1, itemType: "-attachment" });
    caps.sqliteFallback = true;
  } catch {
    caps.sqliteFallback = false;
  }

  try {
    await localGet<ZoteroItem[]>("/items", { limit: "1" });
    caps.localApiRead = true;
  } catch { /* sqliteFallback reports the read-only fallback state */ }

  try {
    const res = await fetchT(`${LOCAL}/connector/ping`, { headers: { Accept: "text/plain" } }, 2_000);
    caps.localConnector = res.ok;
  } catch {
    caps.localConnector = false;
  }

  try {
    const bridgePing = await bridge.pingBridge();
    caps.localBridge = true;
    caps.localBridgeVersion = bridgePing.version;
    caps.zoteroVersion = bridgePing.zoteroVersion;
  } catch {
    caps.localBridge = false;
  }

  try {
    const res = await fetchT(
      `${localBase()}/items`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      },
      2_000
    );
    caps.localApiWrite = res.ok;
    caps.localApiWriteStatus = res.status;
    if (!res.ok) caps.localApiWriteMessage = await res.text().catch(() => res.statusText);
  } catch (e) {
    caps.localApiWrite = false;
    caps.localApiWriteMessage = e instanceof Error ? e.message : String(e);
  }

  return caps;
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
