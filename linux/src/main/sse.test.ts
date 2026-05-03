import { describe, expect, it } from 'vitest';
import { HttpStreamError, parseSseLine, parseSseResponse } from './sse';

describe('SSE parser', () => {
  it('handles text deltas and done events', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hel"}\n\ndata: {"text":"lo"}\n\ndata: [DONE]\n\n'));
        controller.close();
      }
    });

    const events = [];
    for await (const event of parseSseResponse(new Response(body))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'chunk', text: 'hel' },
      { type: 'chunk', text: 'lo' },
      { type: 'done' }
    ]);
  });

  it('reports malformed data lines', () => {
    expect(parseSseLine('data: nope')).toEqual({ type: 'error', error: 'Malformed SSE payload from Worker' });
  });

  it('throws on HTTP errors', async () => {
    await expect(async () => {
      for await (const _event of parseSseResponse(new Response('', { status: 502 }))) {
        // consume stream
      }
    }).rejects.toBeInstanceOf(HttpStreamError);
  });
});
