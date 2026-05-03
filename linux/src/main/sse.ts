import type { ChatStreamEvent } from '../shared/types';

export class HttpStreamError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export async function* parseSseResponse(response: Response): AsyncGenerator<ChatStreamEvent> {
  if (!response.ok) {
    throw new HttpStreamError(`Worker stream failed with HTTP ${response.status}`, response.status);
  }

  if (!response.body) {
    throw new Error('Worker stream response did not include a body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseSseLine(line);
      if (event) {
        yield event;
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const event = parseSseLine(tail);
    if (event) {
      yield event;
    }
  }
}

export function parseSseLine(line: string): ChatStreamEvent | undefined {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
    return undefined;
  }

  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') {
    return { type: 'done' };
  }

  try {
    const parsed = JSON.parse(payload) as { type?: string; text?: string; delta?: string; error?: string };

    if (parsed.error) {
      return { type: 'error', error: parsed.error };
    }

    if (parsed.type === 'done') {
      return { type: 'done' };
    }

    const text = parsed.text ?? parsed.delta;
    return text ? { type: 'chunk', text } : undefined;
  } catch {
    return { type: 'error', error: 'Malformed SSE payload from Worker' };
  }
}
