import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cwd = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "zotero-mcp-smoke-"));
const importFile = join(tempDir, "imported-note.txt");
const linkedFile = join(tempDir, "linked-note.txt");
const localImportPdf = join(tempDir, "local-import-smoke.pdf");
writeFileSync(importFile, "zotero mcp imported attachment smoke\n");
writeFileSync(linkedFile, "zotero mcp linked attachment smoke\n");
writeFileSync(localImportPdf, "%PDF-1.3\n% zotero mcp smoke pdf\n");

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd });
const client = new Client({ name: "zotero-mcp-local-crud-smoke", version: "0.0.0" });
const created = {
  collections: [],
  items: [],
};

function body(result) {
  return (result.content || [])
    .map((part) => part.type === "text" ? part.text : JSON.stringify(part))
    .join("\n");
}

function parseKey(value) {
  const match = value.match(/\[([A-Z0-9]{8})\]|\b([A-Z0-9]{8})\b/);
  if (!match) throw new Error(`Could not parse Zotero key from response:\n${value}`);
  return match[1] || match[2];
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = body(result);
  if (result.isError) throw new Error(`${name} failed:\n${text}`);
  return text;
}

async function localGet(path) {
  const res = await fetch(`http://127.0.0.1:23119${path}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function cleanup() {
  const itemKeys = [...created.items].reverse();
  if (itemKeys.length) {
    try {
      await call("zotero_items", { action: "delete", item_keys: itemKeys, confirm: true, permanent: true });
      console.log(`cleanup items: ${itemKeys.length}`);
    } catch (e) {
      console.error(`cleanup items failed: ${e.message}`);
    }
  }
  for (const key of [...created.collections].reverse()) {
    try {
      await call("zotero_collections", { action: "delete", collection_key: key, confirm: true });
      console.log(`cleanup collection: ${key}`);
    } catch (e) {
      console.error(`cleanup collection ${key} failed: ${e.message}`);
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.length}`);
  if (tools.tools.length !== 11) throw new Error(`Expected 11 semantic tools, got ${tools.tools.length}`);

  const caps = await call("zotero_status", { action: "check" });
  if (!caps.includes("Local bridge plugin | yes")) throw new Error("Local bridge is not loaded");
  console.log("capabilities: local bridge yes");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sourceText = await call("zotero_collections", { action: "create", name: `mcp-smoke-source-${stamp}` });
  const sourceKey = parseKey(sourceText);
  created.collections.push(sourceKey);
  console.log(`source collection: ${sourceKey}`);

  const targetText = await call("zotero_collections", { action: "create", name: `mcp-smoke-target-${stamp}` });
  const targetKey = parseKey(targetText);
  created.collections.push(targetKey);
  console.log(`target collection: ${targetKey}`);

  const itemText = await call("zotero_items", {
    action: "create",
    item_type: "journalArticle",
    title: `MCP Mature Local Smoke ${stamp}`,
    creators: [{ creatorType: "author", firstName: "Local", lastName: "Mature" }],
    fields: { publicationTitle: "MCP Local Smoke Journal", date: "2026" },
    collection_keys: [sourceKey],
    tags: ["mcp-smoke-old-tag"],
  });
  const itemKey = parseKey(itemText);
  created.items.push(itemKey);
  console.log(`item: ${itemKey}`);

  await call("zotero_tags", {
    action: "rename",
    old_tag: "mcp-smoke-old-tag",
    new_tag: "mcp-smoke-new-tag",
    confirm: true,
  });
  const tagged = await localGet(`/api/users/0/items?tag=${encodeURIComponent("mcp-smoke-new-tag")}&limit=10`);
  if (!tagged.some((item) => item.key === itemKey)) throw new Error("Renamed tag not found on smoke item");
  console.log("tag rename: ok");

  const noteText = await call("zotero_notes", {
    action: "create",
    item_key: itemKey,
    content: "Initial local note",
    tags: ["mcp-smoke-note"],
  });
  const noteKey = parseKey(noteText);
  created.items.push(noteKey);
  console.log(`note: ${noteKey}`);

  await call("zotero_notes", {
    action: "update",
    note_key: noteKey,
    content: "Updated local note",
    tags: ["mcp-smoke-note-updated"],
  });
  await call("zotero_notes", {
    action: "append",
    note_key: noteKey,
    content: "Appended local note",
  });
  const notes = await call("zotero_notes", { action: "list", item_key: itemKey });
  if (!notes.includes("Updated local note") || !notes.includes("Appended local note")) {
    throw new Error("Updated/appended note content was not listed");
  }
  console.log("note update/append/list: ok");

  const importedText = await call("zotero_attachments", {
    action: "import",
    item_key: itemKey,
    file_path: importFile,
    title: "imported attachment smoke",
    content_type: "text/plain",
  });
  const importedKey = parseKey(importedText);
  created.items.push(importedKey);
  console.log(`imported attachment: ${importedKey}`);

  const linkedText = await call("zotero_attachments", {
    action: "link_file",
    item_key: itemKey,
    file_path: linkedFile,
    title: "linked attachment smoke",
    content_type: "text/plain",
  });
  const linkedKey = parseKey(linkedText);
  created.items.push(linkedKey);
  console.log(`linked attachment: ${linkedKey}`);

  await call("zotero_attachments", {
    action: "update",
    attachment_key: importedKey,
    title: "updated imported attachment smoke",
    tags: ["mcp-smoke-attachment"],
  });
  await call("zotero_texts", {
    action: "write",
    item_key: itemKey,
    attachment_key: importedKey,
    format: "md",
    content: "# Smoke MD\n\nReadable markdown sidecar.",
  });
  const inventory = await call("zotero_item", { item_key: itemKey });
  if (!inventory.includes(importedKey) || !inventory.includes("| MD |")) {
    throw new Error("Item inventory did not report the imported attachment and MD file");
  }
  const mdText = await call("zotero_texts", {
    action: "read",
    item_key: itemKey,
    attachment_key: importedKey,
    source: "md",
  });
  if (!mdText.includes("Readable markdown sidecar")) {
    throw new Error("zotero_texts action=read did not return the saved MD sidecar");
  }
  console.log("file inventory/write/read: ok");
  const attachments = await call("zotero_attachments", { action: "list", item_key: itemKey });
  if (!attachments.includes(importedKey) || !attachments.includes(linkedKey)) {
    throw new Error("Attachment list did not include both smoke attachments");
  }
  if (!attachments.includes("updated imported attachment smoke")) {
    throw new Error("Attachment update not visible in list");
  }
  console.log("attachment import/link/update/list: ok");

  const localImportText = await call("zotero_import", {
    file_path: localImportPdf,
    collection_key: sourceKey,
  });
  const localImportItemKey = parseKey(localImportText);
  created.items.push(localImportItemKey);
  const localImportItem = await call("zotero_item", { item_key: localImportItemKey });
  const localImportAttachmentKey = localImportItem.match(/\| \[([A-Z0-9]{8})\] local-import-smoke \|/)?.[1];
  if (!localImportAttachmentKey) throw new Error("Could not parse local import attachment key");
  created.items.push(localImportAttachmentKey);
  if (!localImportItem.includes("# local-import-smoke") || localImportItem.includes("# local-import-smoke.pdf")) {
    throw new Error("Local file import did not strip the .pdf suffix from the item title");
  }
  if (!localImportItem.includes("] local-import-smoke | yes |")) {
    throw new Error("Local file import did not strip the .pdf suffix from the attachment title");
  }
  console.log("local file import title cleanup: ok");

  await call("zotero_collections", {
    action: "transfer_items",
    item_keys: [itemKey],
    source_collection_key: sourceKey,
    target_collection_key: targetKey,
    mode: "move",
    confirm: true,
  });
  const movedItem = await localGet(`/api/users/0/items/${itemKey}`);
  if (movedItem.data.collections.includes(sourceKey) || !movedItem.data.collections.includes(targetKey)) {
    throw new Error("Collection move did not update item collections as expected");
  }
  console.log("collection move: ok");

  await cleanup();
  created.items = [];
  created.collections = [];

  const leftovers = await localGet(`/api/users/0/items?tag=${encodeURIComponent("mcp-smoke-new-tag")}&limit=10`);
  if (leftovers.length) throw new Error(`Smoke cleanup left ${leftovers.length} tagged item(s)`);
  console.log("cleanup verification: ok");
} catch (e) {
  console.error(`LOCAL CRUD SMOKE FAILED: ${e.message}`);
  await cleanup().catch(() => {});
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
