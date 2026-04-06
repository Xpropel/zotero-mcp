/**
 * PaddleOCR Integration — 通过百度 PaddleOCR API 将 PDF 转换为 Markdown/JSON/TXT
 *
 * API: layout-parsing endpoint (文档版面分析 + OCR)
 * 支持输出格式: md (Markdown), json (结构化), txt (纯文本)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";

const API_URL =
  process.env.PADDLEOCR_API_URL ||
  "https://32h7fan0h9tfqep6.aistudio-app.com/layout-parsing";
const TOKEN =
  process.env.PADDLEOCR_TOKEN ||
  "8f4947807cc1d3cc41474763fc51190953d2f6ec";
const TIMEOUT = 120_000; // OCR 可能比较慢

export type OcrFormat = "md" | "json" | "txt";

export interface OcrPageResult {
  pageIndex: number;
  markdown: string;
  images: Record<string, string>; // imagePath → imageUrl
}

export interface OcrResult {
  pages: OcrPageResult[];
  fullMarkdown: string;
  fullText: string;
  savedPath?: string;
}

/**
 * 调用 PaddleOCR API 解析 PDF 文件
 */
export async function ocrPdf(pdfPath: string): Promise<OcrResult> {
  if (!existsSync(pdfPath)) {
    throw new Error(`PDF 文件不存在: ${pdfPath}`);
  }

  const fileBytes = readFileSync(pdfPath);
  const fileData = fileBytes.toString("base64");

  const payload = {
    file: fileData,
    fileType: 0, // 0=PDF, 1=image
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);

  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PaddleOCR API ${res.status}: ${body || res.statusText}`);
  }

  const data = (await res.json()) as {
    result?: {
      layoutParsingResults?: Array<{
        markdown?: { text?: string; images?: Record<string, string> };
      }>;
    };
  };

  const results = data.result?.layoutParsingResults;
  if (!results?.length) {
    throw new Error("PaddleOCR 未返回解析结果 — PDF 可能为空或不可识别");
  }

  const pages: OcrPageResult[] = results.map((r, i) => ({
    pageIndex: i,
    markdown: r.markdown?.text || "",
    images: r.markdown?.images || {},
  }));

  const fullMarkdown = pages.map((p) => p.markdown).join("\n\n---\n\n");
  const fullText = fullMarkdown
    .replace(/^#{1,6}\s+/gm, "")       // strip heading markers
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // strip bold
    .replace(/\*([^*]+)\*/g, "$1")      // strip italic
    .replace(/!\[.*?\]\(.*?\)/g, "")    // strip image refs
    .replace(/\[([^\]]+)\]\(.*?\)/g, "$1") // links → text
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { pages, fullMarkdown, fullText };
}

/**
 * 将 OCR 结果保存到 PDF 同目录
 */
export function saveOcrResult(
  pdfPath: string,
  result: OcrResult,
  format: OcrFormat
): string {
  const dir = dirname(pdfPath);
  const base = basename(pdfPath, extname(pdfPath));

  let savePath: string;
  let content: string;

  switch (format) {
    case "md":
      savePath = join(dir, `${base}.md`);
      content = result.fullMarkdown;
      break;
    case "json":
      savePath = join(dir, `${base}.json`);
      content = JSON.stringify(
        {
          source: basename(pdfPath),
          pageCount: result.pages.length,
          pages: result.pages.map((p) => ({
            page: p.pageIndex + 1,
            markdown: p.markdown,
          })),
          fullText: result.fullText,
        },
        null,
        2
      );
      break;
    case "txt":
      savePath = join(dir, `${base}.txt`);
      content = result.fullText;
      break;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(savePath, content, "utf-8");
  return savePath;
}

/**
 * 下载 OCR 结果中的图片到本地
 */
export async function saveOcrImages(
  pdfPath: string,
  result: OcrResult
): Promise<string[]> {
  const dir = dirname(pdfPath);
  const saved: string[] = [];

  for (const page of result.pages) {
    for (const [imgPath, imgUrl] of Object.entries(page.images)) {
      if (!imgUrl) continue;
      try {
        const fullPath = join(dir, imgPath);
        mkdirSync(dirname(fullPath), { recursive: true });
        const imgRes = await fetch(imgUrl);
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          writeFileSync(fullPath, buf);
          saved.push(fullPath);
        }
      } catch {
        // skip failed images
      }
    }
  }

  return saved;
}
