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
      'Execute a bash/shell command on the local Linux machine. Use absolute paths.',
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

export const checkEmailTool: LlmTool = {
  type: 'function',
  function: {
    name: 'check_email',
    description:
      'Fetch recent emails from the user\'s configured inbox. Use this tool EVERY time the user asks about emails, inbox, messages, or mail. NEVER say you cannot access emails. ALWAYS call this tool first.',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'How many recent emails to fetch (default 5, max 10)'
        }
      },
      required: []
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

  messages.push({
    role: 'system',
    content:
      'You are Clicky, a Linux desktop AI assistant with TOOL ACCESS. You have two tools: execute_bash_command and check_email.\n\n' +
      'RULE 1: When the user asks about emails, inbox, messages, or mail — you MUST call the check_email tool. Do not answer from memory. Do not say you cannot access emails. The tool IS available and WILL work.\n\n' +
      'RULE 2: When the user asks about files, directories, system info, or running commands — you MUST call the execute_bash_command tool.\n\n' +
      'RULE 3: Never claim you cannot do something that a tool can do. Always use the appropriate tool.'
  });

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
  console.log('[clicky:openai] SSE parser started');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[clicky:openai] HTTP error:', response.status, body);
    throw new Error(`OpenAI stream failed: HTTP ${response.status} ${body}`);
  }
  if (!response.body) {
    throw new Error('OpenAI stream response did not include a body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let toolCallBuffer: { id: string; name: string; arguments: string } | undefined;
  let chunkCount = 0;
  let toolCallDeltaCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      console.log('[clicky:openai] SSE stream done. Chunks:', chunkCount, 'Tool deltas:', toolCallDeltaCount);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        console.log('[clicky:openai] [DONE] received. Tool buffer:', toolCallBuffer ? toolCallBuffer.name : 'none');
        if (toolCallBuffer) {
          console.log('[clicky:openai] Yielding tool_call:', toolCallBuffer.name, 'args:', toolCallBuffer.arguments);
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
          toolCallDeltaCount++;
          const tc = delta.tool_calls[0];
          console.log('[clicky:openai] Tool call delta:', JSON.stringify(tc));
          if (tc.id && tc.function?.name) {
            toolCallBuffer = { id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '' };
            console.log('[clicky:openai] Tool call started:', toolCallBuffer.name);
          } else if (toolCallBuffer && tc.function?.arguments) {
            toolCallBuffer.arguments += tc.function.arguments;
          }
        }
        if (delta?.content) {
          chunkCount++;
          if (chunkCount <= 3) {
            console.log('[clicky:openai] Text chunk:', delta.content.slice(0, 100));
          }
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
        console.log('[clicky:openai] [DONE] in tail. Tool buffer:', toolCallBuffer ? toolCallBuffer.name : 'none');
        if (toolCallBuffer) {
          console.log('[clicky:openai] Yielding tool_call from tail:', toolCallBuffer.name);
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
    const messages = buildOpenAIMessages(request);
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: executeBashTool.function.name,
          description: executeBashTool.function.description,
          parameters: executeBashTool.function.parameters
        }
      },
      {
        type: 'function' as const,
        function: {
          name: checkEmailTool.function.name,
          description: checkEmailTool.function.description,
          parameters: checkEmailTool.function.parameters
        }
      }
    ];

    const requestBody = {
      model: request.model,
      messages,
      stream: true,
      tools,
      tool_choice: 'auto' as const
    };

    console.log('[clicky:openai] Sending request. Model:', request.model);
    console.log('[clicky:openai] Tools registered:', tools.map(t => t.function.name).join(', '));
    console.log('[clicky:openai] Messages:', JSON.stringify(messages, null, 2));

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log('[clicky:openai] Response status:', response.status);

    for await (const event of parseOpenAISse(response)) {
      console.log('[clicky:openai] Yielding event:', event.type, event.type === 'chunk' ? event.text?.slice(0, 50) : '', event.type === 'tool_call' ? event.name : '');
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
