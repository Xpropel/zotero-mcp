import type { ZoteroItem, ZoteroCreator } from "./types.js";
import { betterBibtexExport } from "./zotero-client.js";

const TYPE_MAP: Record<string, string> = {
  journalArticle: "article",
  book: "book",
  bookSection: "incollection",
  conferencePaper: "inproceedings",
  thesis: "phdthesis",
  report: "techreport",
  webpage: "misc",
  manuscript: "unpublished",
};

function escBib(v: string): string {
  return v.replace(/[{}]/g, (c) => `\\${c}`);
}

export async function generateBibtex(item: ZoteroItem): Promise<string> {
  // Try Better BibTeX first
  const bbt = await betterBibtexExport(item.key);
  if (bbt) return bbt;

  // Fallback: manual generation
  const d = item.data;
  const creators = d.creators ?? [];
  const firstAuthor = creators[0];
  let authorLast = "";
  if (firstAuthor) {
    authorLast = (
      firstAuthor.lastName ??
      (firstAuthor.name?.split(" ").pop() || "")
    ).replace(/\s/g, "");
  }
  const year = d.date?.slice(0, 4) || "nodate";
  const citeKey = `${authorLast}${year}_${item.key}`;
  const bibType = TYPE_MAP[d.itemType] ?? "misc";

  const lines: string[] = [`@${bibType}{${citeKey},`];

  const fields: [string, string | undefined][] = [
    ["title", d.title],
    ["journal", d.publicationTitle],
    ["volume", d.volume],
    ["number", d.issue],
    ["pages", d.pages],
    ["publisher", d.publisher],
    ["doi", d.DOI],
    ["url", d.url],
    ["abstract", d.abstractNote],
  ];

  for (const [bibField, val] of fields) {
    if (val) lines.push(`  ${bibField} = {${escBib(val)}},`);
  }

  const authorNames = creators
    .filter((c: ZoteroCreator) => c.creatorType === "author")
    .map((c: ZoteroCreator) => {
      if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
      return c.name || c.lastName || "";
    })
    .filter(Boolean);

  if (authorNames.length > 0) {
    lines.push(`  author = {${authorNames.join(" and ")}},`);
  }
  if (year !== "nodate") {
    lines.push(`  year = {${year}},`);
  }

  // Remove trailing comma from last field
  const last = lines[lines.length - 1];
  if (last.endsWith(",")) {
    lines[lines.length - 1] = last.slice(0, -1);
  }
  lines.push("}");
  return lines.join("\n");
}
