import { stripPointTags } from '../shared/pointTags';
import type { ChatStreamEvent, LlmTool, TranscribeTokenResponse, VoiceTurnRequest } from '../shared/types';

export interface WorkerApiConfig {
  workerBaseUrl: string;
}

export const executeBashTool: LlmTool = {
  type: 'function',
  function: {
    name: 'execute_bash_command',
    description:
      'You are an AI desktop agent on a Linux machine. You can use the execute_bash_command tool to organize files, create directories, and manage the OS. Always use absolute paths (e.g. ~/Desktop). Execute a bash/shell command on the local machine.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to execute. Use absolute paths like ~/Desktop/...'
        }
      },
      required: ['command']
    }
  }
};

function getOpenAIApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return key;
}

function buildOpenAIMessages(request: VoiceTurnRequest): unknown[] {
  const messages: unknown[] = [];

  for (const entry of request.conversationHistory) {
    messages.push({ role: entry.role, content: entry.content });
  }

  const content: unknown[] = [{ type: 'text', text: request.transcript }];
  for (const capture of request.captures) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${capture.jpegBase64}` }
    });
  }

  messages.push({ role: 'user', content });
  return messages;
}

async function* parseOpenAISse(response: Response): AsyncGenerator<ChatStreamEvent> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI stream failed: HTTP ${response.status} ${body}`);
  }
  if (!response.body) {
    throw new Error('OpenAI stream response did not include a body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallBuffer: { id: string; name: string; arguments: string } | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        if (toolCallBuffer) {
          yield { type: 'tool_call', name: toolCallBuffer.name, arguments: toolCallBuffer.arguments };
        }
        yield { type: 'done' };
        return;
      }
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.tool_calls && delta.tool_calls.length > 0) {
          const tc = delta.tool_calls[0];
          if (tc.id && tc.function?.name) {
            toolCallBuffer = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '' };
          } else if (toolCallBuffer && tc.function?.arguments) {
            toolCallBuffer.arguments += tc.function.arguments;
          }
        }
        if (delta?.content) {
          yield { type: 'chunk', text: delta.content };
        }
      } catch {
        yield { type: 'error', error: 'Malformed SSE payload from OpenAI' };
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const trimmed = tail;
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        if (toolCallBuffer) {
          yield { type: 'tool_call', name: toolCallBuffer.name, arguments: toolCallBuffer.arguments };
        }
        yield { type: 'done' };
      }
    }
  }
}

export class WorkerApi {
  constructor(private readonly config: WorkerApiConfig) {}

  async *sendTurn(request: VoiceTurnRequest): AsyncGenerator<ChatStreamEvent> {
    const apiKey = getOpenAIApiKey();
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: request.model,
        messages: buildOpenAIMessages(request),
        stream: true,
        tools: [
          {
            type: 'function',
            function: {
              name: executeBashTool.function.name,
              description: executeBashTool.function.description,
              parameters: executeBashTool.function.parameters
            }
          }
        ]
      })
    });

    for await (const event of parseOpenAISse(response)) {
      if (event.type === 'chunk' && event.text) {
        yield { ...event, text: stripPointTags(event.text) };
      } else {
        yield event;
      }
    }
  }

  async getTranscribeToken(): Promise<TranscribeTokenResponse> {
    return { token: '' };
  }

  async synthesizeSpeech(text: string): Promise<ArrayBuffer> {
    const apiKey = getOpenAIApiKey();
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: 'alloy',
        input: stripPointTags(text)
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI TTS failed: HTTP ${response.status} ${body}`);
    }

    return response.arrayBuffer();
  }

  private url(pathname: string): string {
    return new URL(pathname, ensureTrailingSlash(this.config.workerBaseUrl)).toString();
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
