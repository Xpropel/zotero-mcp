import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findZoteroDb } from "./utils.js";
import type { LibraryInfo, FeedInfo, FeedItem } from "./types.js";

let _db: Database.Database | null = null;
let _tmpDir: string | null = null;

function getDb(): Database.Database {
  if (!_db) {
    const src = findZoteroDb();
    _tmpDir = mkdtempSync(join(tmpdir(), "zotero-mcp-"));
    const dst = join(_tmpDir, "zotero.sqlite");
    copyFileSync(src, dst);
    _db = new Database(dst, { readonly: true, fileMustExist: true });
  }
  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
  if (_tmpDir) {
    try {
      const dst = join(_tmpDir, "zotero.sqlite");
      if (existsSync(dst)) unlinkSync(dst);
      rmdirSync(_tmpDir);
    } catch { /* best effort */ }
    _tmpDir = null;
  }
}

export function getLibraries(): LibraryInfo[] {
  return getDb()
    .prepare(
      `SELECT l.libraryID, l.type, l.editable,
              g.groupID, g.name as groupName, g.description as groupDescription,
              f.name as feedName, f.url as feedUrl,
              f.lastCheck as feedLastCheck, f.lastUpdate as feedLastUpdate,
              (SELECT COUNT(*) FROM items i
               JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
               WHERE i.libraryID = l.libraryID
               AND it.typeName NOT IN ('attachment','note','annotation')) as itemCount
       FROM libraries l
       LEFT JOIN groups g ON l.libraryID = g.libraryID
       LEFT JOIN feeds f ON l.libraryID = f.libraryID
       ORDER BY l.type, l.libraryID`
    )
    .all() as LibraryInfo[];
}

export function getFeeds(): FeedInfo[] {
  return getDb()
    .prepare(
      `SELECT f.libraryID, f.name, f.url,
              f.lastCheck, f.lastUpdate, f.lastCheckError, f.refreshInterval,
              (SELECT COUNT(*) FROM feedItems fi
               JOIN items i ON fi.itemID = i.itemID
               WHERE i.libraryID = f.libraryID) as itemCount
       FROM feeds f ORDER BY f.name`
    )
    .all() as FeedInfo[];
}

export function getFeedItems(libraryId: number, limit = 20): FeedItem[] {
  return getDb()
    .prepare(
      `SELECT i.itemID, i.key, it.typeName as itemType, i.dateAdded,
              fi.readTime, fi.translatedTime,
              tv.value as title, av.value as abstract, uv.value as url,
              GROUP_CONCAT(
                CASE
                  WHEN c.firstName IS NOT NULL AND c.lastName IS NOT NULL
                  THEN c.lastName || ', ' || c.firstName
                  WHEN c.lastName IS NOT NULL THEN c.lastName
                END, '; '
              ) as creators
       FROM feedItems fi
       JOIN items i ON fi.itemID = i.itemID
       JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
       LEFT JOIN fields tf ON tf.fieldName = 'title'
       LEFT JOIN itemData td ON i.itemID = td.itemID AND td.fieldID = tf.fieldID
       LEFT JOIN itemDataValues tv ON td.valueID = tv.valueID
       LEFT JOIN fields af ON af.fieldName = 'abstractNote'
       LEFT JOIN itemData ad ON i.itemID = ad.itemID AND ad.fieldID = af.fieldID
       LEFT JOIN itemDataValues av ON ad.valueID = av.valueID
       LEFT JOIN fields uf ON uf.fieldName = 'url'
       LEFT JOIN itemData ud ON i.itemID = ud.itemID AND ud.fieldID = uf.fieldID
       LEFT JOIN itemDataValues uv ON ud.valueID = uv.valueID
       LEFT JOIN itemCreators ic ON i.itemID = ic.itemID
       LEFT JOIN creators c ON ic.creatorID = c.creatorID
       WHERE i.libraryID = ?
       GROUP BY i.itemID
       ORDER BY i.dateAdded DESC LIMIT ?`
    )
    .all(libraryId, limit) as FeedItem[];
}
