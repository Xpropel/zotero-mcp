/**
 * When Zotero local HTTP API (127.0.0.1:23119) is unavailable, serve read-only
 * library data directly from zotero.sqlite (same DB path as local-db).
 */
import type Database from "better-sqlite3";
import { getZoteroSqlite } from "./local-db.js";
import type { ZoteroCollection, ZoteroCreator, ZoteroItem, ZoteroItemData } from "./types.js";

const TITLE = "title";
const ABSTRACT = "abstractNote";
const DATE = "date";
const PUBLICATION = "publicationTitle";

function libraryStub(libraryID: number): ZoteroItem["library"] {
  return { type: "user", id: libraryID, name: "My Library" };
}

function rowToCreators(
  rows: Array<{ creatorType: string; firstName: string | null; lastName: string | null; fieldMode: number }>
): ZoteroCreator[] {
  return rows.map((r) => ({
    creatorType: r.creatorType,
    firstName: r.firstName ?? undefined,
    lastName: r.lastName ?? undefined,
  }));
}

function fetchCreators(db: Database.Database, itemIDs: number[]): Map<number, ZoteroCreator[]> {
  const map = new Map<number, ZoteroCreator[]>();
  if (!itemIDs.length) return map;
  const ph = itemIDs.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ic.itemID, ct.creatorType, c.firstName, c.lastName, c.fieldMode, ic.orderIndex
       FROM itemCreators ic
       JOIN creators c ON c.creatorID = ic.creatorID
       JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
       WHERE ic.itemID IN (${ph})
       ORDER BY ic.itemID, ic.orderIndex`
    )
    .all(...itemIDs) as Array<{
    itemID: number;
    creatorType: string;
    firstName: string | null;
    lastName: string | null;
    fieldMode: number;
  }>;
  for (const r of rows) {
    const arr = map.get(r.itemID) ?? [];
    arr.push({
      creatorType: r.creatorType,
      firstName: r.firstName ?? undefined,
      lastName: r.lastName ?? undefined,
    });
    map.set(r.itemID, arr);
  }
  return map;
}

type ItemRow = {
  itemID: number;
  key: string;
  version: number;
  libraryID: number;
  dateAdded: string;
  dateModified: string;
  itemType: string;
  title: string | null;
  abstractNote: string | null;
  date: string | null;
  publicationTitle: string | null;
};

function baseItemSelect(extraWhere: string): string {
  return `
    SELECT i.itemID, i.key, i.version, i.libraryID, i.dateAdded, i.dateModified, it.typeName AS itemType,
           tv.value AS title, av.value AS abstractNote, dv.value AS date, pv.value AS publicationTitle
    FROM items i
    JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
    LEFT JOIN fields f_t ON f_t.fieldName = '${TITLE}'
    LEFT JOIN itemData id_t ON id_t.itemID = i.itemID AND id_t.fieldID = f_t.fieldID
    LEFT JOIN itemDataValues tv ON tv.valueID = id_t.valueID
    LEFT JOIN fields f_a ON f_a.fieldName = '${ABSTRACT}'
    LEFT JOIN itemData id_a ON id_a.itemID = i.itemID AND id_a.fieldID = f_a.fieldID
    LEFT JOIN itemDataValues av ON av.valueID = id_a.valueID
    LEFT JOIN fields f_d ON f_d.fieldName = '${DATE}'
    LEFT JOIN itemData id_d ON id_d.itemID = i.itemID AND id_d.fieldID = f_d.fieldID
    LEFT JOIN itemDataValues dv ON dv.valueID = id_d.valueID
    LEFT JOIN fields f_p ON f_p.fieldName = '${PUBLICATION}'
    LEFT JOIN itemData id_p ON id_p.itemID = i.itemID AND id_p.fieldID = f_p.fieldID
    LEFT JOIN itemDataValues pv ON pv.valueID = id_p.valueID
    WHERE ${extraWhere}`;
}

function toZoteroItem(row: ItemRow, creators: ZoteroCreator[]): ZoteroItem {
  const data: ZoteroItemData = {
    key: row.key,
    itemType: row.itemType,
    title: row.title ?? undefined,
    abstractNote: row.abstractNote ?? undefined,
    date: row.date ?? undefined,
    publicationTitle: row.publicationTitle ?? undefined,
    dateAdded: row.dateAdded,
    dateModified: row.dateModified,
    creators: creators.length ? creators : undefined,
  };
  return {
    key: row.key,
    version: row.version,
    library: libraryStub(row.libraryID),
    data,
  };
}

function enrichNotesForItems(db: Database.Database, items: ZoteroItem[]): ZoteroItem[] {
  return items.map((it) => {
    if (it.data.itemType !== "note") return it;
    const row = db
      .prepare(
        `SELECT n.note, pi.key AS parentKey
         FROM itemNotes n
         JOIN items ni ON ni.itemID = n.itemID
         JOIN items pi ON pi.itemID = n.parentItemID
         WHERE ni.key = ?`
      )
      .get(it.key) as { note: string; parentKey: string } | undefined;
    if (!row) return it;
    return {
      ...it,
      data: { ...it.data, note: row.note, parentItem: row.parentKey },
    };
  });
}

function rowsToItems(db: Database.Database, rows: ItemRow[]): ZoteroItem[] {
  const ids = rows.map((r) => r.itemID);
  const creatorsMap = fetchCreators(db, ids);
  const items = rows.map((r) => toZoteroItem(r, creatorsMap.get(r.itemID) ?? []));
  return enrichNotesForItems(db, items);
}

/** Top-level / any item by key (excludes walking; returns one row). */
export function sqlGetItemByKey(key: string): ZoteroItem | null {
  const db = getZoteroSqlite();
  const row = db
    .prepare(baseItemSelect(`i.key = ?`))
    .get(key) as ItemRow | undefined;
  if (!row) return null;
  return rowsToItems(db, [row])[0] ?? null;
}

export function sqlGetItems(opts: {
  limit?: number;
  start?: number;
  sort?: string;
  direction?: string;
  itemType?: string;
}): ZoteroItem[] {
  const db = getZoteroSqlite();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const start = Math.max(opts.start ?? 0, 0);
  let typeClause = "";
  if (opts.itemType === "-attachment") {
    typeClause = `AND it.typeName != 'attachment'`;
  } else if (opts.itemType) {
    typeClause = `AND it.typeName = ?`;
  }
  const sort = opts.sort === "dateModified" ? "i.dateModified" : opts.sort === "title" ? "COALESCE(tv.value,'')" : "i.dateAdded";
  const dir = (opts.direction ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sql =
    baseItemSelect(`1=1 ${typeClause}`) +
    ` ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`;
  const params: (string | number)[] = [];
  if (opts.itemType && opts.itemType !== "-attachment") params.push(opts.itemType);
  params.push(limit, start);
  const rows = db.prepare(sql).all(...params) as ItemRow[];
  return rowsToItems(db, rows);
}

export function sqlSearchItems(
  query: string,
  opts: { qmode?: string; itemType?: string; limit?: number; sort?: string; direction?: string; tag?: string[] } = {}
): ZoteroItem[] {
  const db = getZoteroSqlite();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 500);
  const q = query.trim();
  let typeClause = "";
  if (opts.itemType === "-attachment") {
    typeClause = `AND it.typeName != 'attachment'`;
  } else if (opts.itemType) {
    typeClause = `AND it.typeName = ?`;
  }
  const sort = opts.sort === "dateModified" ? "i.dateModified" : opts.sort === "title" ? "COALESCE(tv.value,'')" : "i.dateAdded";
  const dir = (opts.direction ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  let tagClause = "";
  if (opts.tag?.length) {
    tagClause = `AND i.itemID IN (
      SELECT itg.itemID FROM itemTags itg
      JOIN tags tg ON tg.tagID = itg.tagID
      WHERE tg.name IN (${opts.tag.map(() => "?").join(",")})
    )`;
  }

  let searchClause = "";
  if (q) {
    searchClause = `AND (
      INSTR(LOWER(COALESCE(tv.value,'')), ?) > 0
      OR INSTR(LOWER(COALESCE(av.value,'')), ?) > 0
      OR INSTR(LOWER(COALESCE(pv.value,'')), ?) > 0
      OR EXISTS (
        SELECT 1 FROM itemCreators ic2
        JOIN creators c2 ON c2.creatorID = ic2.creatorID
        WHERE ic2.itemID = i.itemID AND (
          INSTR(LOWER(COALESCE(c2.lastName,'')), ?) > 0
          OR INSTR(LOWER(COALESCE(c2.firstName,'')), ?) > 0
          OR INSTR(LOWER(COALESCE(c2.lastName,'') || ' ' || COALESCE(c2.firstName,'')), ?) > 0
        )
      )
    )`;
  }

  const sql =
    baseItemSelect(`1=1 ${typeClause} ${tagClause} ${searchClause}`) +
    ` ORDER BY ${sort} ${dir} LIMIT ?`;

  const params: (string | number)[] = [];
  if (opts.itemType && opts.itemType !== "-attachment") params.push(opts.itemType);
  if (opts.tag?.length) params.push(...opts.tag);
  if (q) {
    const needle = q.toLowerCase();
    for (let i = 0; i < 6; i++) params.push(needle);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as ItemRow[];
  return rowsToItems(db, rows);
}

export function sqlGetCollectionItems(collectionKey: string, limit?: number): ZoteroItem[] {
  const db = getZoteroSqlite();
  const lim = Math.min(Math.max(limit ?? 50, 1), 500);
  const sql = `
    SELECT i.itemID, i.key, i.version, i.libraryID, i.dateAdded, i.dateModified, it.typeName AS itemType,
           tv.value AS title, av.value AS abstractNote, dv.value AS date, pv.value AS publicationTitle
    FROM collectionItems ci
    JOIN collections col ON col.collectionID = ci.collectionID AND col.key = ?
    JOIN items i ON i.itemID = ci.itemID
    JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
    LEFT JOIN fields f_t ON f_t.fieldName = '${TITLE}'
    LEFT JOIN itemData id_t ON id_t.itemID = i.itemID AND id_t.fieldID = f_t.fieldID
    LEFT JOIN itemDataValues tv ON tv.valueID = id_t.valueID
    LEFT JOIN fields f_a ON f_a.fieldName = '${ABSTRACT}'
    LEFT JOIN itemData id_a ON id_a.itemID = i.itemID AND id_a.fieldID = f_a.fieldID
    LEFT JOIN itemDataValues av ON av.valueID = id_a.valueID
    LEFT JOIN fields f_d ON f_d.fieldName = '${DATE}'
    LEFT JOIN itemData id_d ON id_d.itemID = i.itemID AND id_d.fieldID = f_d.fieldID
    LEFT JOIN itemDataValues dv ON dv.valueID = id_d.valueID
    LEFT JOIN fields f_p ON f_p.fieldName = '${PUBLICATION}'
    LEFT JOIN itemData id_p ON id_p.itemID = i.itemID AND id_p.fieldID = f_p.fieldID
    LEFT JOIN itemDataValues pv ON pv.valueID = id_p.valueID
    WHERE it.typeName != 'attachment'
    ORDER BY i.dateAdded DESC
    LIMIT ?`;
  const rows = db.prepare(sql).all(collectionKey, lim) as ItemRow[];
  return rowsToItems(db, rows);
}

export function sqlGetCollections(): ZoteroCollection[] {
  const db = getZoteroSqlite();
  const rows = db
    .prepare(
      `SELECT c.key, c.version, c.collectionName AS name,
              pc.key AS parentKey,
              (SELECT COUNT(*) FROM collectionItems ci WHERE ci.collectionID = c.collectionID) AS numItems
       FROM collections c
       LEFT JOIN collections pc ON pc.collectionID = c.parentCollectionID
       ORDER BY c.collectionName`
    )
    .all() as Array<{
    key: string;
    version: number;
    name: string;
    parentKey: string | null;
    numItems: number;
  }>;
  return rows.map((r) => ({
    key: r.key,
    version: r.version,
    data: {
      key: r.key,
      name: r.name,
      parentCollection: r.parentKey ? r.parentKey : false,
    },
    meta: { numItems: r.numItems },
  }));
}

export function sqlGetCollectionByKey(key: string): ZoteroCollection | null {
  const db = getZoteroSqlite();
  const r = db
    .prepare(
      `SELECT c.key, c.version, c.collectionName AS name,
              pc.key AS parentKey,
              (SELECT COUNT(*) FROM collectionItems ci WHERE ci.collectionID = c.collectionID) AS numItems
       FROM collections c
       LEFT JOIN collections pc ON pc.collectionID = c.parentCollectionID
       WHERE c.key = ?`
    )
    .get(key) as
    | {
        key: string;
        version: number;
        name: string;
        parentKey: string | null;
        numItems: number;
      }
    | undefined;
  if (!r) return null;
  return {
    key: r.key,
    version: r.version,
    data: { key: r.key, name: r.name, parentCollection: r.parentKey ? r.parentKey : false },
    meta: { numItems: r.numItems },
  };
}

export function sqlGetTags(limit?: number): Array<{ tag: string; meta: { numItems: number } }> {
  const db = getZoteroSqlite();
  const lim = limit !== undefined ? Math.min(Math.max(limit, 1), 10000) : 10000;
  const rows = db
    .prepare(
      `SELECT tg.name AS tag, COUNT(itg.itemID) AS numItems
       FROM tags tg
       LEFT JOIN itemTags itg ON itg.tagID = tg.tagID
       GROUP BY tg.tagID
       ORDER BY numItems DESC
       LIMIT ?`
    )
    .all(lim) as Array<{ tag: string; numItems: number }>;
  return rows.map((r) => ({ tag: r.tag, meta: { numItems: r.numItems } }));
}

/** Child attachments + notes for a parent item key (same role as API /children). */
export function sqlGetItemChildren(parentKey: string): ZoteroItem[] {
  const db = getZoteroSqlite();
  const parent = db.prepare(`SELECT itemID FROM items WHERE key = ?`).get(parentKey) as { itemID: number } | undefined;
  if (!parent) return [];
  const childIds = db
    .prepare(
      `SELECT itemID FROM itemAttachments WHERE parentItemID = ?
       UNION ALL
       SELECT itemID FROM itemNotes WHERE parentItemID = ?`
    )
    .all(parent.itemID, parent.itemID) as Array<{ itemID: number }>;
  if (!childIds.length) return [];

  const ph = childIds.map(() => "?").join(",");
  const rows = db
    .prepare(baseItemSelect(`i.itemID IN (${ph})`))
    .all(...childIds.map((x) => x.itemID)) as ItemRow[];
  const items = rowsToItems(db, rows);
  return items.map((it) => sqlPatchAttachmentData(it));
}

/** Enrich attachment rows with filename + storage path for findBestAttachment. */
export function sqlPatchAttachmentData(item: ZoteroItem): ZoteroItem {
  if (item.data.itemType !== "attachment") return item;
  const db = getZoteroSqlite();
  const row = db
    .prepare(
      `SELECT ia.contentType, ia.path FROM itemAttachments ia
       JOIN items i ON i.itemID = ia.itemID WHERE i.key = ?`
    )
    .get(item.key) as { contentType: string | null; path: string | null } | undefined;
  if (!row) return item;
  const fn = db
    .prepare(
      `SELECT v.value FROM itemData id
       JOIN fields f ON f.fieldName = 'filename' AND id.fieldID = f.fieldID
       JOIN itemDataValues v ON v.valueID = id.valueID
       WHERE id.itemID = (SELECT itemID FROM items WHERE key = ?)`
    )
    .get(item.key) as { value: string } | undefined;
  const rel = row.path ?? "";
  const storagePath = rel ? (rel.startsWith("storage:") ? rel : `storage:${rel}`) : undefined;
  return {
    ...item,
    data: {
      ...item.data,
      path: storagePath,
      filename: fn?.value ?? item.data.filename,
      contentType: row.contentType ?? item.data.contentType,
    },
  };
}
