# Zotero MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI assistants to your local Zotero library. Read, search, annotate, and manage your references through natural language.

## Features

- **Search** — keyword search with optional tag filtering
- **Metadata** — view item details in Markdown or BibTeX, with PDF path included
- **PDF Path** — get absolute file path for use with external OCR tools (e.g. PaddleOCR-VL)
- **Notes** — read, search, and create notes on items
- **Annotations** — read highlights/comments; create new annotations via Web API
- **Collections & Tags** — browse collection trees, list/update tags in batch
- **Libraries** — list user/group/feed libraries; switch active library
- **RSS Feeds** — list subscriptions and browse feed items

## Prerequisites

- **Zotero 7** (or 6) running locally with the default API server on port `23119`
- **Node.js** ≥ 18
- *(Optional)* [Better BibTeX](https://retorque.re/zotero-better-bibtex/) plugin for enhanced BibTeX export and annotation retrieval
- *(Optional)* Zotero Web API credentials for write operations (create notes, annotations, update tags)

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
| `ZOTERO_API_KEY` | For writes | [Zotero API key](https://www.zotero.org/settings/keys/new) with read/write access |
| `ZOTERO_LIBRARY_ID` | For writes | Your Zotero user ID (visible on the API keys page) |
| `ZOTERO_LIBRARY_TYPE` | No | `user` (default) or `group` |

### Data Directory Auto-Detection

The server locates `zotero.sqlite` automatically:

| Platform | Paths checked |
|---|---|
| macOS | `~/Zotero`, `~/Library/Application Support/Zotero/Profiles` |
| Windows | `~/Zotero`, `%APPDATA%/Zotero/Zotero` |
| Linux | `~/Zotero`, `~/.zotero/zotero` |

Set `ZOTERO_DATA_DIR` if your data directory is in a non-standard location.

### MCP Client Configuration

Add to your MCP client config (e.g. Claude Desktop, Cursor):

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

## Available Tools (17)

### Search (2)

| Tool | Description |
|---|---|
| `zotero_search_items` | Search by keyword and/or tag filters |
| `zotero_get_recent` | Get recently added items |

### Metadata & Content (6)

| Tool | Description |
|---|---|
| `zotero_get_item_metadata` | Get item details (Markdown or BibTeX), includes PDF path |
| `zotero_get_item_pdfpath` | Get absolute PDF file path for external tools (e.g. PaddleOCR-VL) |
| `zotero_get_item_children` | List attachments and notes for an item |
| `zotero_get_collections` | Browse collection hierarchy |
| `zotero_get_collection_items` | List items in a collection |
| `zotero_get_tags` | List all tags sorted by usage |

### Notes

| Tool | Description |
|---|---|
| `zotero_get_notes` | Get notes for an item or all notes |
| `zotero_search_notes` | Full-text search through notes |
| `zotero_create_note` | Create a note on an item (Web API or Connector) |

### Annotations

| Tool | Description |
|---|---|
| `zotero_get_annotations` | Get highlights/comments for an item |
| `zotero_create_annotation` | Create a highlight annotation (requires Web API) |

### Library Management

| Tool | Description |
|---|---|
| `zotero_list_libraries` | List all accessible libraries |
| `zotero_switch_library` | Switch active library context |
| `zotero_list_feeds` | List RSS feed subscriptions |
| `zotero_get_feed_items` | Browse items from an RSS feed |
| `zotero_batch_update_tags` | Batch add/remove tags (Web API or preview) |

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
    ├── search.ts       # Search tools
    ├── metadata.ts     # Metadata & content tools
    ├── notes.ts        # Note tools
    ├── annotations.ts  # Annotation tools
    └── library.ts      # Library management tools
```

### Data Access Layers

1. **Local Zotero API** (`localhost:23119`) — primary read channel, no auth needed
2. **Zotero Web API** (`api.zotero.org`) — write operations (notes, annotations, tag updates)
3. **SQLite direct read** (`better-sqlite3`) — library/feed metadata; auto-refreshes when source changes

## Scripts

```bash
npm run build   # Compile TypeScript to dist/
npm start       # Run compiled server
npm run dev     # Run directly with tsx (development)
```

## License

MIT
