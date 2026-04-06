/**
 * DOI Import — 通过 DOI 获取元数据 + 自动下载 OA PDF
 *
 * 元数据来源: CrossRef API
 * PDF 来源级联: Unpaywall → Semantic Scholar → PubMed Central → CrossRef links
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CROSSREF = "https://api.crossref.org/works";
const UNPAYWALL = "https://api.unpaywall.org/v2";
const S2 = "https://api.semanticscholar.org/graph/v1/paper";
const NCBI_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const TIMEOUT = 20_000;
const POLITE_EMAIL = process.env.UNPAYWALL_EMAIL || "zotero-mcp@users.noreply.github.com";

function fetchT(url: string, init?: RequestInit, ms = TIMEOUT): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}

// ── CrossRef metadata ──

export interface CrossRefMeta {
  title: string;
  authors: Array<{ firstName?: string; lastName?: string; name?: string }>;
  date?: string;
  year?: string;
  doi: string;
  url?: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  abstract?: string;
  itemType: string;
  issn?: string;
}

export async function getCrossRefMeta(doi: string): Promise<CrossRefMeta> {
  const res = await fetchT(`${CROSSREF}/${encodeURIComponent(doi)}`, {
    headers: { Accept: "application/json", "User-Agent": `ZoteroMCP/3.0 (mailto:${POLITE_EMAIL})` },
  });
  if (!res.ok) throw new Error(`CrossRef ${res.status}: DOI not found`);

  const data = (await res.json()) as { message: Record<string, any> };
  const m = data.message;

  const authors = (m.author || []).map((a: any) => ({
    firstName: a.given || undefined,
    lastName: a.family || undefined,
    name: a.name || undefined,
  }));

  const dateArr = m["published-print"]?.["date-parts"]?.[0] ||
    m["published-online"]?.["date-parts"]?.[0] ||
    m.issued?.["date-parts"]?.[0];
  const date = dateArr ? dateArr.filter(Boolean).join("-") : undefined;
  const year = dateArr?.[0]?.toString();

  // Determine item type
  let itemType = "journalArticle";
  const type = m.type || "";
  if (type.includes("book-chapter") || type.includes("book-section")) itemType = "bookSection";
  else if (type.includes("book")) itemType = "book";
  else if (type.includes("proceedings") || type.includes("conference")) itemType = "conferencePaper";
  else if (type.includes("report")) itemType = "report";
  else if (type.includes("thesis") || type.includes("dissertation")) itemType = "thesis";

  const title = Array.isArray(m.title) ? m.title[0] : m.title || "Untitled";
  const abstract = m.abstract
    ? m.abstract.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    : undefined;

  return {
    title,
    authors,
    date,
    year,
    doi: m.DOI || doi,
    url: m.URL || `https://doi.org/${doi}`,
    journal: m["container-title"]?.[0],
    volume: m.volume,
    issue: m.issue,
    pages: m.page,
    publisher: m.publisher,
    abstract,
    itemType,
    issn: m.ISSN?.[0],
  };
}

// ── OA PDF URL discovery (cascade) ──

export interface PdfSource {
  url: string;
  source: "unpaywall" | "semantic_scholar" | "pmc" | "crossref";
}

async function tryUnpaywall(doi: string): Promise<PdfSource | null> {
  try {
    const res = await fetchT(`${UNPAYWALL}/${encodeURIComponent(doi)}?email=${POLITE_EMAIL}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { best_oa_location?: { url_for_pdf?: string; url?: string } };
    const loc = data.best_oa_location;
    if (loc?.url_for_pdf) return { url: loc.url_for_pdf, source: "unpaywall" };
    return null;
  } catch {
    return null;
  }
}

async function trySemanticScholar(doi: string): Promise<PdfSource | null> {
  try {
    const res = await fetchT(`${S2}/DOI:${encodeURIComponent(doi)}?fields=openAccessPdf,externalIds`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      openAccessPdf?: { url: string };
      externalIds?: { ArXiv?: string };
    };
    if (data.openAccessPdf?.url) return { url: data.openAccessPdf.url, source: "semantic_scholar" };
    if (data.externalIds?.ArXiv) {
      return { url: `https://arxiv.org/pdf/${data.externalIds.ArXiv}.pdf`, source: "semantic_scholar" };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryPMC(doi: string): Promise<PdfSource | null> {
  try {
    const res = await fetchT(
      `${NCBI_SEARCH}?db=pmc&term=${encodeURIComponent(doi)}&retmode=json`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { esearchresult?: { idlist?: string[] } };
    const id = data.esearchresult?.idlist?.[0];
    if (!id) return null;
    return { url: `https://pmc.ncbi.nlm.nih.gov/articles/PMC${id}/pdf/`, source: "pmc" };
  } catch {
    return null;
  }
}

async function tryCrossRefLinks(doi: string): Promise<PdfSource | null> {
  try {
    const res = await fetchT(`${CROSSREF}/${encodeURIComponent(doi)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { message?: { link?: Array<{ URL: string; "content-type"?: string }> } };
    const links = data.message?.link || [];
    const pdf = links.find((l) => l["content-type"]?.includes("pdf"));
    if (pdf?.URL) return { url: pdf.URL, source: "crossref" };
    return null;
  } catch {
    return null;
  }
}

export async function findOaPdf(doi: string): Promise<PdfSource | null> {
  // Cascade: Unpaywall → Semantic Scholar → PMC → CrossRef
  return (
    (await tryUnpaywall(doi)) ||
    (await trySemanticScholar(doi)) ||
    (await tryPMC(doi)) ||
    (await tryCrossRefLinks(doi))
  );
}

// ── PDF download ──

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export async function downloadPdf(
  pdfUrl: string,
  destDir: string,
  filename: string
): Promise<{ path: string; size: number } | null> {
  try {
    mkdirSync(destDir, { recursive: true });
    const res = await fetchT(
      pdfUrl,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/pdf,*/*",
        },
        redirect: "follow",
      },
      30_000
    );
    if (!res.ok) return null;

    const ct = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());

    // Verify it's actually a PDF (not an HTML error page)
    if (buf.length < 100) return null;
    const header = buf.subarray(0, 5).toString("ascii");
    if (header !== "%PDF-" && !ct.includes("pdf")) return null;

    const savePath = join(destDir, filename);
    writeFileSync(savePath, buf);
    return { path: savePath, size: buf.length };
  } catch {
    return null;
  }
}

// ── Convert CrossRef meta to Zotero item format ──

export function metaToZoteroPayload(
  meta: CrossRefMeta,
  collectionKey?: string
): Record<string, unknown> {
  const creators = meta.authors.map((a) => ({
    creatorType: "author",
    firstName: a.firstName || "",
    lastName: a.lastName || a.name || "",
  }));

  const payload: Record<string, unknown> = {
    itemType: meta.itemType,
    title: meta.title,
    creators,
    DOI: meta.doi,
    url: meta.url,
    date: meta.date,
    abstractNote: meta.abstract,
  };

  if (meta.itemType === "journalArticle") {
    payload.publicationTitle = meta.journal;
    payload.volume = meta.volume;
    payload.issue = meta.issue;
    payload.pages = meta.pages;
  } else if (meta.itemType === "book" || meta.itemType === "bookSection") {
    payload.publisher = meta.publisher;
  } else if (meta.itemType === "conferencePaper") {
    payload.publicationTitle = meta.journal;
  }

  if (collectionKey) {
    payload.collections = [collectionKey];
  }

  return payload;
}
