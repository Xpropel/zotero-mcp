# Zotero MCP Server v3.3

Local-first Zotero MCP server and CLI for managing a real Zotero Desktop
library. The project now favors a smaller set of high-value tools over broad
shortcuts.

## What This Tool Is For

| Goal | Current support |
|---|---|
| Inspect one Zotero item | Metadata, attachments, PDF/MD/TXT inventory, notes, annotations |
| Manage item files | Import/link PDF or other attachments; save or import MD/TXT sidecar files |
| Read LLM-ready text | Read saved MD/TXT sidecars or Zotero's text index, not raw PDF bytes |
| Write locally | Create/update/delete items, notes, attachments, collections, tags through a Zotero plugin |
| Organize a library | Collections, item moves, tag rename/merge/delete, duplicate checks |

## Architecture

```
AI client / CLI
      |
      v
src/index.ts, src/cli.ts
      |
      v
src/zotero-client.ts
      |------------------------------|
      v                              v
Zotero local API                 Zotero MCP Local Bridge plugin
127.0.0.1:23119/api             127.0.0.1:23119/mcp-bridge/*
read-only local data            local CRUD via Zotero internal APIs
```

Zotero's built-in local API is reliable for reads but does not implement item
CRUD writes. This project ships `zotero-local-bridge`, a Zotero Desktop plugin
that exposes a narrow local endpoint set:

```
/mcp-bridge/ping
/mcp-bridge/items/create
/mcp-bridge/items/update
/mcp-bridge/items/delete
/mcp-bridge/collections/create
/mcp-bridge/collections/update
/mcp-bridge/collections/delete
/mcp-bridge/collections/add-items
/mcp-bridge/collections/remove-items
/mcp-bridge/attachments/import-file
/mcp-bridge/attachments/link-file
/mcp-bridge/attachments/link-url
```

No Zotero cloud API key is required for local CRUD. Direct SQLite writes are not
used.

## Install

```bash
npm install
npm run build
npm run plugin:pack
```

Install `dist-plugin/zotero-mcp-local-bridge.xpi` in Zotero Desktop through
`Tools -> Add-ons -> Install Add-on From File...`.

Verify:

```bash
curl -sS -H 'Zotero-Allowed-Request: 1' \
  http://127.0.0.1:23119/mcp-bridge/ping

npm run dev:cli -- status
```

Expected bridge response:

```json
{"ok":true,"result":{"version":"0.2.0","zoteroVersion":"9.0.3","userLibraryID":1}}
```

## MCP Tools

The v3.3 interface has 23 focused tools.

| Area | Tools | Purpose |
|---|---|---|
| Search | `zotero_search` | Find candidate items with file availability indicators |
| Item inventory | `zotero_item` | Inspect one item: metadata, attachment keys, PDF/MD/TXT state, notes, annotations |
| File text | `zotero_read_file`, `zotero_manage_files`, `zotero_ocr` | Read or create MD/TXT sidecars for an item's attachment |
| Item CRUD | `zotero_create_item`, `zotero_update`, `zotero_delete_items`, `zotero_add` | Create, import, edit, delete Zotero items |
| Notes | `zotero_create_note`, `zotero_search_notes`, `zotero_manage_notes` | Create, find, update, append, delete notes |
| Attachments | `zotero_manage_attachments` | List/import/link/update/delete Zotero attachments |
| Organization | `zotero_collections`, `zotero_manage_collections`, `zotero_move_items` | Browse and manage collections |
| Tags | `zotero_tags`, `zotero_batch_tags`, `zotero_manage_tags` | Batch tag edits plus rename/merge/delete |
| Quality/export | `zotero_duplicates`, `zotero_export` | Duplicate checks and BibTeX export |
| Runtime | `zotero_capabilities`, `zotero_libraries` | Diagnose local bridge/API state and switch library |

Removed weak shortcuts: `zotero_recent`, `zotero_feeds`, `zotero_fulltext`,
and `zotero_save_txt`.

## File Model

Zotero items normally hold one or more attachments. A PDF attachment can later
gain readable sidecar files in the same Zotero storage directory:

| File type | Meaning |
|---|---|
| PDF | Original attachment file |
| MD | Markdown text extracted or written for LLM reading |
| TXT | Plain-text extraction or notes cache |
| Note | Zotero child note item, managed separately from files |

Use `zotero_item` first. It returns the attachment key and whether PDF, MD, and
TXT files exist. Then use:

| Tool | Use |
|---|---|
| `zotero_manage_files` with `action=list` | Inspect PDF/MD/TXT paths for an item attachment |
| `zotero_manage_files` with `action=write_text` | Save supplied MD/TXT content next to the attachment |
| `zotero_manage_files` with `action=import_file` | Copy an existing local `.md` or `.txt` into Zotero storage |
| `zotero_read_file` | Read existing MD/TXT text for LLM analysis |
| `zotero_ocr` | Generate text from PDF when no readable MD/TXT exists |

`zotero_read_file` replaces the old `zotero_fulltext` name. It reads text
representations; it does not parse PDF bytes directly.

## CLI Commands

```
search [query]         Search with filters
item <key>             Item details with file inventory
read-file <key>        Read saved MD/TXT text
ocr <key>              PaddleOCR conversion
add <dois...>          DOI import with optional OA PDF download
duplicates             Detect duplicate items
notes <query>          Search notes
note <key> <content>   Create child note
collections [key]      Browse collections
tags                   List tags
tag <query>            Batch tag update
export <keys...>       Export BibTeX
libraries              List/switch libraries
status                 System status check
```

## Environment Variables

| Variable | Required | Description |
|---|---:|---|
| `ZOTERO_DATA_DIR` | No | Override auto-detected Zotero data directory |
| `ZOTERO_FORCE_SQLITE` | No | Set `1` to force read-only SQLite fallback |
| `ZOTERO_DISABLE_SQLITE_FALLBACK` | No | Set `1` to fail instead of using SQLite fallback |
| `PADDLEOCR_API_URL` | No | Custom PaddleOCR endpoint |
| `PADDLEOCR_TOKEN` | No | Custom PaddleOCR auth token |
| `UNPAYWALL_EMAIL` | No | Email for Unpaywall polite pool during DOI import |

## Smoke Test

```bash
npm run smoke:local-crud
```

The smoke test runs through MCP stdio against a real Zotero Desktop instance. It
creates temporary collections, an item, a note, imported and linked attachments,
a saved MD sidecar file, tag edits, and a collection move. It verifies the
results through Zotero's local API and permanently deletes only the temporary
test data.

## Source Layout

```
src/
├── index.ts            MCP stdio entry point
├── server.ts           focused tool registration
├── cli.ts              CLI entry point
├── zotero-client.ts    Local API + bridge facade
├── local-bridge.ts     HTTP client for /mcp-bridge endpoints
├── local-db.ts         SQLite read-only metadata access
├── sql-fallback.ts     SQLite read-only item queries
├── doi-import.ts       CrossRef metadata + OA PDF lookup
├── paddle-ocr.ts       PaddleOCR integration
└── tools/              MCP tool modules

zotero-local-bridge/
├── manifest.json       Zotero plugin manifest
└── bootstrap.js        Local CRUD endpoint implementation
```

## License

MIT
