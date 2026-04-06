# Zotero MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI assistants to your local Zotero library. Read, search, annotate, and manage your references through natural language.

## Features

- **Search** — keyword search with tag/collection filtering, sorted by date or title
- **Item Details** — get metadata, abstract, PDF/TXT paths, notes, and annotations in one call
- **TXT Caching** — save OCR-converted text alongside PDFs for future reuse
- **Notes** — search and create notes on items
- **Collections & Tags** — browse collection trees, list/batch-update tags
- **BibTeX Export** — export items as BibTeX (via Better BibTeX or built-in fallback)
- **Libraries & Feeds** — list/switch libraries, browse RSS feed items

## Prerequisites

- **Zotero 7** (or 6) running locally with the default API server on port `23119`
- **Node.js** ≥ 18
- *(Optional)* [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin for enhanced BibTeX export and annotation retrieval
- *(Recommended for notes under an item)* Zotero Web API credentials (`ZOTERO_API_KEY` + `ZOTERO_LIBRARY_ID`). The local Connector **cannot** attach a standalone note to an existing parent entry (Zotero client limitation); Web API sets `parentItem` correctly. After a Web API write, run **Sync** in Zotero to refresh the local library.
- *(Optional)* Same credentials are used for other writes (e.g. batch tag updates).

## Installation

```bash
git clone <repo-url> && cd zotero-mcp
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ZOTERO_DATA_DIR` | No | Override auto-detected Zotero data directory path |
| `ZOTERO_API_KEY` | For some writes / fallback | [Zotero API key](https://www.zotero.org/settings/keys/new) with read/write access |
| `ZOTERO_LIBRARY_ID` | With API key | Your Zotero user ID (visible on the API keys page) |
| `ZOTERO_LIBRARY_TYPE` | No | `user` (default) or `group` |
| `ZOTERO_NOTES_WRITE_MODE` | No | How `zotero_create_note` writes: **`auto` (default)** = if `ZOTERO_API_KEY` + `ZOTERO_LIBRARY_ID` are set, use **Web API** so the note is a **child of the item** (`parentItem` works); otherwise use **Connector** (note may land in the save-target collection only — Zotero’s `ItemSaver` ignores `parentItem` on standalone connector notes). `local` = Connector only; `web` = Web API only. |

### Data Directory Auto-Detection

The server locates `zotero.sqlite` automatically:

| Platform | Paths checked |
|---|---|
| macOS | `~/Zotero`, `~/Library/Application Support/Zotero/Profiles` |
| Windows | `~/Zotero`, `%APPDATA%/Zotero/Zotero` |
| Linux | `~/Zotero`, `~/.zotero/zotero` |

Set `ZOTERO_DATA_DIR` if your data directory is in a non-standard location.

### MCP Client Configuration

Add to your MCP client config (e.g. Claude Desktop, Claude Code, Cursor):

```json
{
  "mcpServers": {
    "zotero": {
      "command": "node",
      "args": ["/absolute/path/to/zotero-mcp/dist/index.js"],
      "env": {
        "ZOTERO_API_KEY": "your-api-key",
        "ZOTERO_LIBRARY_ID": "your-library-id"
      }
    }
  }
}
```

For development with auto-reload:

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

## Available Tools (11)

### Search (1)

| Tool | Description |
|---|---|
| `zotero_search` | Search by keyword, tag, or collection. Supports sorting by `dateAdded`, `dateModified`, or `title`. Returns a lean list with PDF/TXT availability indicators. |

### Item Details (2)

| Tool | Description |
|---|---|
| `zotero_item` | Get comprehensive details for an item in one call: metadata, abstract, PDF/TXT file paths, existing notes, and annotations. |
| `zotero_save_txt` | Save PaddleOCR-converted text alongside the PDF in Zotero storage for future reuse. |

### Notes (2)

| Tool | Description |
|---|---|
| `zotero_search_notes` | Full-text search through note contents across the library. |
| `zotero_create_note` | Create a child note on an item (same level as PDF under that entry). Default **`auto`**: **Web API** when keys are set (correct `parentItem`); else **Connector** (parent link not applied — see README). |

### Organization (3)

| Tool | Description |
|---|---|
| `zotero_collections` | List all collections as a tree, or get items within a specific collection. |
| `zotero_tags` | List all tags sorted by usage count. |
| `zotero_batch_tags` | Batch add or remove tags on items matching a search query. |

### Export (1)

| Tool | Description |
|---|---|
| `zotero_export` | Export one or more items as BibTeX. Supports bulk export. |

### Library Management (2)

| Tool | Description |
|---|---|
| `zotero_libraries` | List all accessible libraries and RSS feeds, or switch the active library. |
| `zotero_feeds` | Get items from a specific RSS feed. |

## Architecture

```
src/
├── index.ts            # Entry point, lifecycle management
├── server.ts           # MCP server creation, tool registration
├── zotero-client.ts    # HTTP client (local API + Web API)
├── local-db.ts         # SQLite access (read-only copy of zotero.sqlite)
├── types.ts            # TypeScript interfaces
├── utils.ts            # Helpers (path resolution, HTML, formatting)
├── bibtex.ts           # BibTeX generation (Better BibTeX or fallback)
├── formatters.ts       # Output formatting for tool responses
└── tools/
    ├── search.ts       # zotero_search
    ├── item.ts         # zotero_item, zotero_save_txt
    ├── notes.ts        # zotero_search_notes, zotero_create_note
    ├── organize.ts     # zotero_collections, zotero_tags, zotero_batch_tags
    ├── export.ts       # zotero_export
    └── library.ts      # zotero_libraries, zotero_feeds
```

### Data Access Layers

1. **Local Zotero API** (`localhost:23119`) — primary read channel, no auth needed
2. **Zotero Web API** (`api.zotero.org`) — **default for new notes** when API keys are set, so notes are real child items (`parentItem` respected). Sync pulls them into the desktop library.
3. **Local Zotero Connector** (`/connector/saveItems`) — fallback when Web API is not configured; standalone notes do not receive `parentItem` (Zotero `Translate.ItemSaver` behavior).
4. **SQLite direct read** (`better-sqlite3`) — library/feed metadata; auto-refreshes when source changes

## Scripts

```bash
npm run build   # Compile TypeScript to dist/
npm start       # Run compiled server
npm run dev     # Run directly with tsx (development)
```

## License

MIT
