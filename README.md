# Zotero MCP Server v3.2

Local-first Zotero MCP server and CLI. It reads from Zotero Desktop's local API
and performs local CRUD writes through a small Zotero Desktop plugin included in
this repo.

## Highlights

- 25 MCP tools for search, reading, OCR, import, notes, attachments, collections, tags, export, and CRUD management
- 16 CLI commands for local terminal workflows
- Local CRUD bridge plugin for create/update/delete items, notes, collections, and collection membership
- Mature local management workflows: note update/append/delete, attachment import/link/update/delete, tag rename/merge/delete, collection copy/move
- SQLite read-only fallback when the Zotero local API is unavailable
- PaddleOCR integration for PDF-to-Markdown/JSON/TXT conversion
- DOI import with CrossRef metadata and optional OA PDF lookup
- BibTeX export via Better BibTeX or built-in fallback

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

The built-in Zotero local REST API is reliable for reads but does not implement
item CRUD writes. This project therefore ships `zotero-local-bridge`, a Zotero
Desktop plugin that exposes a narrow local endpoint prefix:

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

No Zotero cloud credentials are required for CRUD. Direct SQLite writes are not
used.

## Install

```bash
npm install
npm run build
```

### Install the Zotero bridge plugin

Package the plugin:

```bash
npm run plugin:pack
```

Then install `dist-plugin/zotero-mcp-local-bridge.xpi` in Zotero Desktop:

1. Open Zotero.
2. Open `Tools -> Add-ons`.
3. Choose `Install Add-on From File...`.
4. Select `dist-plugin/zotero-mcp-local-bridge.xpi`.
5. Restart Zotero if the endpoint is not active immediately.

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

## MCP Client Configuration

```json
{
  "mcpServers": {
    "zotero": {
      "command": "node",
      "args": ["/absolute/path/to/zotero-mcp/dist/index.js"]
    }
  }
}
```

Development mode:

```json
{
  "mcpServers": {
    "zotero": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/zotero-mcp/src/index.ts"]
    }
  }
}
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

## MCP Tools

| Area | Tools |
|---|---|
| Search | `zotero_search`, `zotero_recent` |
| Read | `zotero_item`, `zotero_fulltext`, `zotero_ocr`, `zotero_save_txt` |
| Import/write | `zotero_add`, `zotero_create_item`, `zotero_create_note`, `zotero_update`, `zotero_delete_items` |
| Notes and attachments | `zotero_search_notes`, `zotero_manage_notes`, `zotero_manage_attachments` |
| Organize | `zotero_collections`, `zotero_tags`, `zotero_batch_tags`, `zotero_manage_tags`, `zotero_manage_collections`, `zotero_move_items`, `zotero_duplicates` |
| Export/library | `zotero_export`, `zotero_capabilities`, `zotero_libraries`, `zotero_feeds` |

## CLI Commands

```
search [query]         Search with filters (-t tags, -y year, -T type, -s sort)
item <key>             Item details with file indicators
fulltext <key>         Read full text (MD > TXT > index)
ocr <key>              PaddleOCR conversion (-f md|json|txt)
add <dois...>          DOI import with optional OA PDF download
recent                 Recently added items (-d days)
duplicates             Detect duplicates (-c collection)
notes <query>          Search notes
note <key> <content>   Create child note through the local bridge
collections [key]      Browse collection tree
tags                   List all tags
tag <query>            Batch tag update (-a add, -r remove)
export <keys...>       Export BibTeX
libraries              List libraries and feeds
feeds <id>             RSS feed items
status                 System status check
```

## Source Layout

```
src/
├── index.ts            MCP stdio entry point
├── server.ts           25 tool registrations
├── cli.ts              CLI entry point
├── zotero-client.ts    Local API + bridge client facade
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

## Data Access Boundaries

| Layer | Purpose | Mutates Zotero data |
|---|---|---:|
| Zotero local API (`/api`) | Primary item, collection, tag, note reads | No |
| Zotero MCP Local Bridge (`/mcp-bridge`) | Local item/note/collection/attachment CRUD | Yes |
| SQLite fallback | Read-only fallback and library/feed metadata | No |
| CrossRef / OA PDF lookup | Optional DOI import metadata and PDF discovery | Creates only after bridge write |
| PaddleOCR | Optional OCR service for PDF text extraction | Saves text files locally |

## Smoke Test

After installing the plugin and building:

```bash
npm run build
npm run plugin:pack
npm run dev:cli -- status
npm run dev:cli -- search "" -n 3
npm run smoke:local-crud
```

`npm run smoke:local-crud` runs a real Zotero integration test through MCP stdio:
it creates temporary collections, an item, a note, imported and linked
attachments, tags, and collection moves; then it verifies the results through
Zotero's local API and permanently deletes only the temporary smoke-test data.

## License

MIT
