import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  htmlToMarkdown,
  markdownToText,
  scrapeWebsite,
  type ScrapeResult,
} from './scraper.js';

describe('htmlToMarkdown', () => {
  it('extracts title from <title>', () => {
    const html = '<html><head><title>Hello World</title></head><body></body></html>';
    const result = htmlToMarkdown(html);
    expect(result.title).toBe('Hello World');
  });

  it('converts links to markdown', () => {
    const html = '<a href="https://example.com">Click here</a>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('[Click here](https://example.com)');
  });

  it('converts headings to markdown', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('# Title');
    expect(result.text).toContain('## Subtitle');
    expect(result.text).toContain('### Section');
  });

  it('converts list items', () => {
    const html = '<ul><li>First</li><li>Second</li></ul>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('- First');
    expect(result.text).toContain('- Second');
  });

  it('strips scripts and styles', () => {
    const html = '<script>alert("x")</script><style>.x{color:red}</style><p>Hello</p>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('Hello');
  });

  it('decodes HTML entities', () => {
    const html = '<p>Hello &amp; goodbye &lt;world&gt;</p>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('Hello & goodbye <world>');
  });
});

describe('markdownToText', () => {
  it('strips link syntax', () => {
    const md = 'See [example](https://example.com)';
    expect(markdownToText(md)).toBe('See example');
  });

  it('strips heading syntax', () => {
    const md = '# Title\n\n## Subtitle';
    expect(markdownToText(md)).toBe('Title\n\nSubtitle');
  });

  it('strips list syntax', () => {
    const md = '- First\n- Second';
    expect(markdownToText(md)).toBe('First\nSecond');
  });

  it('strips inline code', () => {
    const md = 'Use `npm install`';
    expect(markdownToText(md)).toBe('Use npm install');
  });

  it('strips code blocks', () => {
    const md = '```js\nconst x = 1;\n```';
    expect(markdownToText(md)).toBe('const x = 1;');
  });
});

describe('scrapeWebsite', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockResponse(params: {
    body: string;
    contentType: string;
    status?: number;
    url?: string;
    ok?: boolean;
  }): Response {
    const ok = params.ok ?? (params.status ?? 200) < 400;
    return {
      ok,
      status: params.status ?? 200,
      statusText: ok ? 'OK' : 'Error',
      url: params.url ?? 'https://example.com',
      headers: new Map([['content-type', params.contentType]]) as unknown as Headers,
      body: null,
      text: () => Promise.resolve(params.body),
      json: () => Promise.resolve(JSON.parse(params.body)),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(params.body).buffer),
      blob: () => Promise.resolve(new Blob([params.body])),
      clone: () => mockResponse(params),
      bodyUsed: false,
      redirected: false,
      type: 'basic',
    } as unknown as Response;
  }

  it('extracts HTML with Readability when available', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '<html><head><title>Article Title</title></head><body><article><h1>Heading</h1><p>Paragraph text.</p></article></body></html>',
        contentType: 'text/html',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({ url: 'https://example.com' });
    expect(result.extractor).toBe('readability');
    expect(result.title).toBe('Article Title');
    expect(result.text).toContain('Heading');
    expect(result.text).toContain('Paragraph text');
    expect(result.contentType).toBe('text/html');
  });

  it('falls back to basic HTML extraction when Readability fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '<html><head><title>Page</title></head><body><nav>Nav</nav><main><h1>Title</h1><p>Content</p></main></body></html>',
        contentType: 'text/html',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({ url: 'https://example.com' });
    expect(result.extractor).toBeOneOf(['readability', 'basic-html']);
    expect(result.text).toContain('Title');
    expect(result.text).toContain('Content');
  });

  it('returns markdown for HTML when extractMode is markdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '<h1>Hello</h1><p>World</p>',
        contentType: 'text/html',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({
      url: 'https://example.com',
      extractMode: 'markdown',
    });
    expect(result.text).toContain('# Hello');
  });

  it('returns plain text for HTML when extractMode is text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '<h1>Hello</h1><p>World</p>',
        contentType: 'text/html',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({
      url: 'https://example.com',
      extractMode: 'text',
    });
    expect(result.text).toContain('Hello');
    expect(result.text).not.toContain('# Hello');
  });

  it('pretty-prints JSON responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '{"key":"value","num":42}',
        contentType: 'application/json',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({ url: 'https://api.example.com/data' });
    expect(result.extractor).toBe('json');
    expect(result.text).toContain('"key": "value"');
    expect(result.text).toContain('"num": 42');
  });

  it('passes through markdown responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '# Heading\n\nSome text.',
        contentType: 'text/markdown',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({ url: 'https://example.com/readme.md' });
    expect(result.extractor).toBe('markdown');
    expect(result.text).toContain('# Heading');
  });

  it('truncates text exceeding maxChars', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '<p>' + 'a'.repeat(300) + '</p>',
        contentType: 'text/html',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({
      url: 'https://example.com',
      maxChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(100);
  });

  it('retries once on transient failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(
        mockResponse({
          body: '<p>Success</p>',
          contentType: 'text/html',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({ url: 'https://example.com' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('Success');
  });

  it('throws after two failed attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(scrapeWebsite({ url: 'https://example.com' })).rejects.toThrow('Network error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on HTTP error after retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: 'Not Found',
        contentType: 'text/html',
        status: 404,
        ok: false,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(scrapeWebsite({ url: 'https://example.com' })).rejects.toThrow('HTTP 404');
  });

  it('includes response body truncation warning', async () => {
    const bodyText = '<p>' + 'a'.repeat(300) + '</p>';
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(bodyText.slice(0, 50)),
      encoder.encode(bodyText.slice(50, 100)),
      encoder.encode(bodyText.slice(100)),
    ];
    let chunkIndex = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          controller.enqueue(chunks[chunkIndex]);
          chunkIndex += 1;
        } else {
          controller.close();
        }
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://example.com',
      headers: new Map([['content-type', 'text/html']]) as unknown as Headers,
      body: stream,
      text: () => Promise.resolve(bodyText),
      json: () => Promise.resolve({}),
      arrayBuffer: () => Promise.resolve(encoder.encode(bodyText).buffer),
      blob: () => Promise.resolve(new Blob([bodyText])),
      clone: () => ({}) as Response,
      bodyUsed: false,
      redirected: false,
      type: 'basic',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({
      url: 'https://example.com',
      maxResponseBytes: 100,
    });
    expect(result.text).toContain('Response body truncated after 100 bytes');
  });

  it('reports finalUrl after redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        body: '<p>Hello</p>',
        contentType: 'text/html',
        url: 'https://example.com/final',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result: ScrapeResult = await scrapeWebsite({ url: 'https://example.com/redirect' });
    expect(result.finalUrl).toBe('https://example.com/final');
  });
});
