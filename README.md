# Zotero MCP Server v3.1

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server + CLI that connects AI assistants to your local Zotero library. Search, read, import, annotate, and manage your references through natural language.

## Highlights

- **18 MCP tools** for LLM-driven literature management
- **16 CLI commands** for terminal-based workflows
- **DOI import** with OA PDF auto-download (Unpaywall / Semantic Scholar / PubMed Central)
- **PaddleOCR integration** for PDF-to-Markdown/JSON/TXT conversion
- **Full-text reading** directly in LLM context (auto-selects MD > TXT > Zotero index)
- **Advanced search** with year range, item type, tag filtering, sort control
- **Duplicate detection** by DOI and title similarity
- **Collection management** (create, add/remove items)
- **BibTeX export** via Better BibTeX or built-in fallback

## Quick Start

```bash
git clone https://github.com/Xpropel/zotero-mcp.git
cd zotero-mcp
npm install
npm run build
```

### MCP Client (Claude Desktop / Cherry Studio / Cursor)

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

### CLI

```bash
node dist/cli.js search "machine learning" -y 2023-2025 -n 10
node dist/cli.js item ABC12345
node dist/cli.js ocr ABC12345 -f md
node dist/cli.js fulltext ABC12345
node dist/cli.js add 10.1038/s41586-024-07487-w
node dist/cli.js duplicates
```

## Prerequisites

- **Zotero 7** (or 6) running locally with default API on port `23119`
- **Node.js** >= 18
- *(Optional)* [Better BibTeX](https://retorque.re/zotero-better-bibtex/) for enhanced BibTeX export
- *(Recommended)* Zotero Web API credentials for write operations (import, notes, tags, collections)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ZOTERO_API_KEY` | For writes | [Zotero API key](https://www.zotero.org/settings/keys/new) with read/write access |
| `ZOTERO_LIBRARY_ID` | With API key | Your Zotero user ID |
| `ZOTERO_LIBRARY_TYPE` | No | `user` (default) or `group` |
| `ZOTERO_DATA_DIR` | No | Override auto-detected Zotero data directory |
| `ZOTERO_NOTES_WRITE_MODE` | No | `auto` (default) / `local` / `web` |
| `PADDLEOCR_API_URL` | No | Custom PaddleOCR API endpoint |
| `PADDLEOCR_TOKEN` | No | Custom PaddleOCR auth token |
| `UNPAYWALL_EMAIL` | No | Email for Unpaywall API polite pool |

## MCP Tools (18)

### Search & Browse

| Tool | Description |
|---|---|
| `zotero_search` | Advanced search with keyword, tags, collection, year range, item type, sort |
| `zotero_recent` | Recently added items (with optional day filter) |

### Read & Analyze

| Tool | Description |
|---|---|
| `zotero_item` | Comprehensive item details: metadata, abstract, files (PDF/MD/TXT), notes, annotations |
| `zotero_fulltext` | Read full text for LLM analysis (auto-selects MD > TXT > Zotero index) |
| `zotero_ocr` | Convert PDF to Markdown/JSON/TXT via PaddleOCR |
| `zotero_save_txt` | Save text alongside PDF in Zotero storage |

### Import & Write

| Tool | Description |
|---|---|
| `zotero_add` | Import by DOI with CrossRef metadata + OA PDF auto-download |
| `zotero_create_note` | Create child note on an item |
| `zotero_update` | Update item metadata (title, DOI, abstract, tags, etc.) |

### Organize

| Tool | Description |
|---|---|
| `zotero_collections` | List collection tree or browse items in a collection |
| `zotero_tags` | List all tags by usage count |
| `zotero_batch_tags` | Batch add/remove tags on search results |
| `zotero_manage_collections` | Create collections, add/remove items |
| `zotero_duplicates` | Find duplicate items by DOI or title similarity |

### Export & Library

| Tool | Description |
|---|---|
| `zotero_export` | Export items as BibTeX |
| `zotero_search_notes` | Search note contents across library |
| `zotero_libraries` | List/switch libraries |
| `zotero_feeds` | Browse RSS feed items |

## CLI Commands (16)

```
search [query]         Search with filters (-t tags, -y year, -T type, -s sort)
item <key>             Item details with file indicators
fulltext <key>         Read full text (MD > TXT > index)
ocr <key>              PaddleOCR conversion (-f md|json|txt)
add <dois...>          DOI import with OA PDF download
recent                 Recently added items (-d days)
duplicates             Detect duplicates (-c collection)
notes <query>          Search notes
note <key> <content>   Create note
collections [key]      Browse collection tree
tags                   List all tags
tag <query>            Batch tag update (-a add, -r remove)
export <keys...>       Export BibTeX
libraries              List libraries & feeds
feeds <id>             RSS feed items
status                 System status check
```

## Architecture

```
src/
├── index.ts            Entry point + lifecycle
├── server.ts           18 tool registration
├── cli.ts              CLI with 16 commands
├── zotero-client.ts    HTTP client (local + Web API + Connector)
├── doi-import.ts       CrossRef metadata + OA PDF cascade
├── paddle-ocr.ts       PaddleOCR API integration
├── local-db.ts         SQLite access (read-only copy)
├── sql-fallback.ts     SQL queries when API unavailable
├── bibtex.ts           BibTeX generation
├── formatters.ts       Response formatting + suggested_next
├── types.ts            TypeScript interfaces
├── utils.ts            Helpers (paths, HTML, files)
└── tools/
    ├── search.ts       zotero_search, zotero_recent
    ├── item.ts         zotero_item, zotero_save_txt
    ├── fulltext.ts     zotero_fulltext
    ├── ocr.ts          zotero_ocr
    ├── import.ts       zotero_add
    ├── notes.ts        zotero_search_notes, zotero_create_note
    ├── organize.ts     zotero_collections, zotero_tags, zotero_batch_tags
    ├── manage.ts       zotero_duplicates, zotero_manage_collections, zotero_update
    ├── export.ts       zotero_export
    └── library.ts      zotero_libraries, zotero_feeds
```

### Data Access

1. **Local Zotero API** (`localhost:23119`) — primary read, no auth
2. **Zotero Web API** (`api.zotero.org`) — writes (import, notes, tags, collections)
3. **SQLite fallback** (`better-sqlite3`) — when API unavailable
4. **CrossRef API** — DOI metadata resolution
5. **Unpaywall / Semantic Scholar / PMC** — OA PDF discovery
6. **PaddleOCR API** — PDF layout analysis + OCR

### OA PDF Download Cascade

When importing via DOI, the system attempts to find and download an open-access PDF:

```
Unpaywall → Semantic Scholar (+ arXiv) → PubMed Central → CrossRef links
```

If direct HTTP download is blocked by CDN (Cloudflare/Akamai), the PDF URL is saved as a linked attachment.

## Scripts

```bash
npm run build      # Compile TypeScript
npm start          # Run MCP server
npm run cli        # Run CLI
npm run dev        # Development mode (tsx)
npm run dev:cli    # CLI development mode
```

## Changelog

### v3.1.0

- DOI import with OA PDF auto-download (Unpaywall/S2/PMC cascade)
- Full-text reading tool (auto-select MD > TXT > Zotero index)
- PaddleOCR integration (PDF to MD/JSON/TXT)
- Advanced search (year range, item type filter, sort direction)
- Duplicate detection (DOI + title matching)
- Collection management (create, add/remove items)
- Item metadata update
- CLI with 16 commands
- suggested_next dynamic hints

### v2.0.0

- Streamlined from 17 to 11 tools
- Modular architecture refactor
- SQLite fallback when API unavailable

### v1.0.0

- Initial release with search, item details, notes, collections, tags, export

## License

MIT
