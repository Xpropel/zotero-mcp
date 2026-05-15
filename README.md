# Zotero MCP Server v3.4

Local-first Zotero MCP server and CLI for managing a real Zotero Desktop
library. v3.4 compresses the MCP surface to 9 strong tools and moves related
operations behind explicit `action` parameters.

## What This Tool Is For

| Goal | Current support |
|---|---|
| Inspect one Zotero item | Metadata, attachments, PDF/MD/TXT inventory, notes, annotations |
| Manage item files | Import/link attachments; save/import/read MD/TXT sidecars; OCR PDFs |
| Write locally | Create/update/delete items, notes, attachments, collections, and tags through a Zotero plugin |
| Organize a library | Collections, item moves, tag rename/merge/delete, duplicate checks |
| Diagnose runtime | Local API, SQLite fallback, Local Bridge plugin, library switching |

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
that exposes narrow local write endpoints. No Zotero cloud API key is required,
and direct SQLite writes are not used.

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

## MCP Tools

The v3.4 interface exposes 9 consolidated tools.

| Tool | Main actions | Purpose |
|---|---|---|
| `zotero_status` | `check`, `libraries`, `switch_library` | Diagnose local runtime and select a Zotero library |
| `zotero_search` | filtered search | Find candidate items with PDF/MD/TXT indicators |
| `zotero_item` | single item read | Inspect metadata, file inventory, notes, and annotations |
| `zotero_items` | `create`, `update`, `delete`, `import_doi`, `duplicates` | Manage item records |
| `zotero_files` | `list`, `read`, `write_text`, `import_sidecar`, `import_attachment`, `link_attachment`, `link_url`, `update_attachment`, `delete_attachment`, `ocr` | Manage attachments and readable sidecar files |
| `zotero_notes` | `list`, `search`, `create`, `update`, `append`, `delete` | Manage Zotero child notes |
| `zotero_collections` | `list`, `items`, `create`, `rename`, `move`, `delete`, `add_items`, `remove_items`, `move_items` | Browse and manage collections |
| `zotero_tags` | `list`, `batch`, `rename`, `merge`, `delete` | Manage tags across items |
| `zotero_export` | BibTeX export | Export references |

Removed weak or fragmented public tools include `zotero_recent`,
`zotero_feeds`, `zotero_fulltext`, `zotero_save_txt`, `zotero_read_file`,
`zotero_manage_files`, `zotero_ocr`, `zotero_create_item`, `zotero_update`,
`zotero_delete_items`, `zotero_add`, `zotero_create_note`,
`zotero_manage_notes`, `zotero_search_notes`, `zotero_manage_attachments`,
`zotero_manage_collections`, `zotero_move_items`, `zotero_batch_tags`,
`zotero_manage_tags`, `zotero_capabilities`, and `zotero_libraries`.

## File Model

Zotero items normally hold one or more attachments. A PDF attachment can later
gain readable sidecar files in the same Zotero storage directory:

| File type | Meaning |
|---|---|
| PDF | Original attachment file |
| MD | Markdown extraction or LLM-ready reading file |
| TXT | Plain-text extraction or readable fallback |
| Note | Zotero child note item, managed separately from files |

Use `zotero_item` first. It returns attachment keys and whether PDF, MD, and TXT
files exist. Then use `zotero_files`:

| Action | Use |
|---|---|
| `list` | Inspect PDF/MD/TXT paths for item attachments |
| `read` | Read existing MD/TXT text or Zotero's text index |
| `write_text` | Save supplied MD/TXT content next to an attachment |
| `import_sidecar` | Copy an existing local `.md` or `.txt` into Zotero storage |
| `ocr` | Generate MD/TXT/JSON text from a PDF attachment |
| `import_attachment`, `link_attachment`, `link_url` | Add attachment records |
| `update_attachment`, `delete_attachment` | Edit or remove attachment records |

## CLI Commands

The CLI remains available for local terminal workflows:

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
verifies the 9-tool interface, creates temporary collections, an item, a note,
imported and linked attachments, a saved MD sidecar file, tag edits, and a
collection move. It verifies the results through Zotero's local API and
permanently deletes only the temporary test data.

## Source Layout

```
src/
├── index.ts            MCP stdio entry point
├── server.ts           consolidated tool registration
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
