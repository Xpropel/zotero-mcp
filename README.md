# Zotero MCP Server v3.5.1

Local-first Zotero MCP server and CLI for managing a real Zotero Desktop
library. v3.5.1 favors semantic tool boundaries over forced consolidation: each
tool maps to one Zotero object or workflow, with cleaner parameters.

## What This Tool Is For

| Goal | Current support |
|---|---|
| Inspect one Zotero item | Metadata, attachments, PDF/MD/TXT inventory, notes, annotations |
| Manage attachments | Import stored files, link local files, link URLs, update or delete attachments |
| Manage readable text | Read/write/import MD/TXT sidecars, read Zotero text index, OCR PDFs |
| Write locally | Create/update/delete items, notes, attachments, collections, and tags through a Zotero plugin |
| Organize a library | Collections, item transfers, tag rename/merge/delete, duplicate checks |
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

The v3.5.1 interface exposes 11 semantic tools.

| Tool | Actions | Purpose |
|---|---|---|
| `zotero_status` | `check`, `libraries`, `switch_library` | Diagnose local runtime and select a Zotero library |
| `zotero_search` | filtered search | Find candidate items with PDF/MD/TXT indicators |
| `zotero_item` | single item read | Inspect metadata, file inventory, notes, and annotations |
| `zotero_items` | `create`, `update`, `delete`, `duplicates` | Manage item records |
| `zotero_import` | DOI params or `file_path` | Import DOI metadata or a local file without metadata lookup |
| `zotero_attachments` | `list`, `import`, `link_file`, `link_url`, `update`, `delete` | Manage Zotero attachment records; local file display titles default to the file name without extension |
| `zotero_texts` | `list`, `read`, `write`, `import`, `ocr` | Manage MD/TXT/JSON text representations for attachments |
| `zotero_notes` | `list`, `search`, `create`, `update`, `append`, `delete` | Manage Zotero child notes |
| `zotero_collections` | `list`, `items`, `create`, `rename`, `set_parent`, `delete`, `add_items`, `remove_items`, `transfer_items` | Browse and manage collections |
| `zotero_tags` | `list`, `update_items`, `rename`, `merge`, `delete` | Manage tags across explicit or matched items |
| `zotero_export` | BibTeX export | Export references |

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
files exist. Then use the correct object-specific tool:

| Need | Tool |
|---|---|
| Add/remove/link attachment records | `zotero_attachments` |
| Read or create MD/TXT sidecars | `zotero_texts` |
| OCR a PDF into MD/TXT/JSON | `zotero_texts` with `action=ocr` |
| Create or update Zotero notes | `zotero_notes` |

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
verifies the 11-tool interface, creates temporary collections, an item, a note,
imported and linked attachments, a saved MD sidecar file, tag edits, and a
collection transfer. It verifies the results through Zotero's local API and
permanently deletes only the temporary test data.

## Source Layout

```
src/
├── index.ts            MCP stdio entry point
├── server.ts           semantic tool registration
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
