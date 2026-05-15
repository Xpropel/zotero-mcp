# Zotero MCP Server v2 Notes

This file is retained only as a historical marker. The current project is v3.3
and is documented in `README.md`.

The old v2 design mixed local reads with remote write fallbacks. That design is
no longer the target architecture. Current CRUD writes should go through the
included Zotero Desktop plugin at `/mcp-bridge/*`, not through cloud credentials
or direct SQLite mutation.
