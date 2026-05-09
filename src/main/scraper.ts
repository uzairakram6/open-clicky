import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export type ExtractMode = 'markdown' | 'text';

export interface ScrapeOptions {
  url: string;
  extractMode?: ExtractMode;
  maxChars?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface ScrapeResult {
  url: string;
  finalUrl?: string;
  title?: string;
  text: string;
  truncated: boolean;
  contentType: string;
  extractor: 'readability' | 'basic-html' | 'json' | 'raw' | 'markdown';
}

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|iframe|svg|canvas|template|object|embed)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(script|style|noscript|iframe|svg|canvas|template|object|embed)>/gi, ' ');
}

export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;

  let text = html;
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    if (!label) return href;
    return `[${label}](${href})`;
  });

  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = '#'.repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return `\n${prefix} ${label}\n`;
  });

  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : '';
  });

  text = text
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol|blockquote|pre)>/gi, '\n');

  text = stripTags(text);
  text = normalizeWhitespace(text);

  return { text, title };
}

export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '');
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1');
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''),
  );
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  return normalizeWhitespace(text);
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ response: Response; finalUrl: string; text: string; truncated: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeout);

      const finalUrl = response.url || url;

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      let text: string;
      let truncated = false;

      if (maxResponseBytes > 0 && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytesRead = 0;
        const parts: string[] = [];

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            let chunk = value;
            if (bytesRead + chunk.byteLength > maxResponseBytes) {
              const remaining = Math.max(0, maxResponseBytes - bytesRead);
              if (remaining <= 0) {
                truncated = true;
                break;
              }
              chunk = chunk.subarray(0, remaining);
              truncated = true;
            }
            bytesRead += chunk.byteLength;
            parts.push(decoder.decode(chunk, { stream: true }));

            if (truncated || bytesRead >= maxResponseBytes) {
              truncated = true;
              break;
            }
          }
        } catch {
          void 0;
        } finally {
          if (truncated) {
            try {
              await reader.cancel();
            } catch {
              void 0;
            }
          }
        }
        parts.push(decoder.decode());
        text = parts.join('');
      } else {
        text = await response.text();
      }

      return { response, finalUrl, text, truncated };
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastError;
}

async function extractReadabilityContent(
  html: string,
  url: string,
  extractMode: ExtractMode,
): Promise<{ text: string; title?: string } | null> {
  try {
    const { document } = parseHTML(html);
    try {
      (document as { baseURI?: string }).baseURI = url;
    } catch {
      void 0;
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) {
      return null;
    }

    const title = parsed.title || undefined;
    if (extractMode === 'text') {
      const text = normalizeWhitespace(parsed.textContent ?? '');
      return text ? { text, title } : null;
    }

    const rendered = htmlToMarkdown(parsed.content);
    const text = normalizeWhitespace(rendered.text);
    return text ? { text, title: title ?? rendered.title } : null;
  } catch {
    return null;
  }
}

async function extractBasicHtmlContent(
  html: string,
  extractMode: ExtractMode,
): Promise<{ text: string; title?: string } | null> {
  const cleanHtml = sanitizeHtml(html);
  const rendered = htmlToMarkdown(cleanHtml);
  if (extractMode === 'text') {
    const text = normalizeWhitespace(markdownToText(rendered.text)) || normalizeWhitespace(stripTags(cleanHtml));
    return text ? { text, title: rendered.title } : null;
  }
  const text = normalizeWhitespace(rendered.text);
  return text ? { text, title: rendered.title } : null;
}

export async function scrapeWebsite(options: ScrapeOptions): Promise<ScrapeResult> {
  const url = options.url;
  const extractMode = options.extractMode ?? 'markdown';
  const maxChars = Math.max(100, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  console.log('[clicky:scrape] fetching', { url, extractMode, maxChars });

  const { response, finalUrl, text: body, truncated: bodyTruncated } = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: 'text/markdown, text/html;q=0.9, */*;q=0.1',
        'User-Agent': userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    timeoutMs,
    maxResponseBytes,
  );

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const normalizedType = contentType.split(';')[0]?.trim()?.toLowerCase() ?? 'application/octet-stream';

  console.log('[clicky:scrape] fetched', { url, finalUrl, bytes: body.length, contentType: normalizedType, bodyTruncated });

  let title: string | undefined;
  let extractor: ScrapeResult['extractor'] = 'raw';
  let extractedText = body;

  if (normalizedType.includes('text/markdown')) {
    extractor = 'markdown';
    if (extractMode === 'text') {
      extractedText = markdownToText(body);
    }
  } else if (normalizedType.includes('text/html')) {
    const readable = await extractReadabilityContent(body, finalUrl, extractMode);
    if (readable?.text) {
      extractedText = readable.text;
      title = readable.title;
      extractor = 'readability';
    } else {
      const basic = await extractBasicHtmlContent(body, extractMode);
      if (basic?.text) {
        extractedText = basic.text;
        title = basic.title;
        extractor = 'basic-html';
      }
    }
  } else if (normalizedType.includes('application/json')) {
    try {
      extractedText = JSON.stringify(JSON.parse(body), null, 2);
      extractor = 'json';
    } catch {
      extractedText = body;
      extractor = 'raw';
    }
  } else if (normalizedType.includes('text/plain')) {
    extractor = 'raw';
    if (extractMode === 'text') {
      extractedText = normalizeWhitespace(body);
    }
  }

  const truncatedResult = truncateText(extractedText, maxChars);
  const warning = bodyTruncated ? `Response body truncated after ${maxResponseBytes} bytes.\n\n` : '';
  const finalText = warning + truncatedResult.text;

  console.log('[clicky:scrape] extracted', {
    url,
    chars: finalText.length,
    extractor,
    truncated: truncatedResult.truncated,
  });

  return {
    url,
    finalUrl,
    title,
    text: finalText,
    truncated: truncatedResult.truncated,
    contentType: normalizedType,
    extractor,
  };
}
