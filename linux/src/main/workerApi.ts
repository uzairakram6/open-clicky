import { homedir, tmpdir } from 'node:os';
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
      'Execute a bash/shell command on the local Linux machine. Use absolute paths. When saving files, use the home directory or /tmp/.',
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

export const writeFileTool: LlmTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Writes code or text to a file under /tmp/clicky_apps on the local Linux file system. Use this to create minimal websites, scripts, and demo apps before launching them.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute file path under /tmp/clicky_apps, such as /tmp/clicky_apps/stopwatch/index.html.'
        },
        content: {
          type: 'string',
          description: 'The complete UTF-8 text/code content to write.'
        }
      },
      required: ['file_path', 'content']
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

export const openUrlTool: LlmTool = {
  type: 'function',
  function: {
    name: 'open_url',
    description:
      'Opens a specified web URL in the user\'s default web browser. Use this if the user explicitly asks to open a link, visit a website, or if you extract a relevant link from the screen context that the user wants to see.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The web URL to open. Must be a valid http or https URL.'
        }
      },
      required: ['url']
    }
  }
};

export const scrapeWebsiteTool: LlmTool = {
  type: 'function',
  function: {
    name: 'scrape_website',
    description:
      'Fetches and extracts readable content from a web URL. Use this when the user asks about content on a specific website, wants to summarize a page, or needs information from a web page. Returns structured markdown or plain text with the page title when available.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The web URL to scrape. Must be a valid http or https URL.'
        },
        extractMode: {
          type: 'string',
          enum: ['markdown', 'text'],
          description: 'Output format: markdown (default) preserves headings and links; text returns plain text.'
        },
        maxChars: {
          type: 'number',
          description: 'Maximum characters to return. Default 50000.'
        }
      },
      required: ['url']
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

export function buildOpenAIMessages(request: VoiceTurnRequest): unknown[] {
  const messages: unknown[] = [];

  messages.push({
    role: 'system',
    content:
      'You are Clicky, a Linux desktop AI assistant with TOOL ACCESS. You have five tools: execute_bash_command, write_file, check_email, open_url, and scrape_website.\n\n' +
      'RULE 1: When the user asks about emails, inbox, messages, or mail — you MUST call the check_email tool. Do not answer from memory. Do not say you cannot access emails. The tool IS available and WILL work.\n\n' +
      'RULE 2: When the user asks about files, directories, system info, or running commands — you MUST call the execute_bash_command tool.\n\n' +
      'RULE 3: When the user asks to open a link, visit a website, or if you see a relevant URL in the screen context the user wants to visit — you MUST call the open_url tool.\n\n' +
      'RULE 4: When the user asks about content on a website, wants to summarize a page, or needs information from a web page — you MUST call the scrape_website tool.\n\n' +
      'RULE 5: When the user asks you to build an app, website, game, tool, or script, act as a practical software engineer: choose the simplest local technology, prefer one static HTML/CSS/JS file for websites and mini apps, use Python only when it is clearly useful, write files under /tmp/clicky_apps/<short-name>/ with write_file, then launch the result with execute_bash_command using xdg-open for HTML files or python3 for Python scripts. Keep generated apps minimal, functional, and demo-friendly.\n\n' +
      'RULE 6: Never claim you cannot do something that a tool can do. Always use the appropriate tool.\n\n' +
      `FILESYSTEM CONTEXT: The user's home directory is ${homedir()}, the temp directory is ${tmpdir()}, and the current working directory is ${process.cwd()}. Generated apps should be saved under /tmp/clicky_apps/. For other user-requested file work, use paths under the home directory or /tmp/. Never assume paths like /home/oai/share exist.`
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
          name: writeFileTool.function.name,
          description: writeFileTool.function.description,
          parameters: writeFileTool.function.parameters
        }
      },
      {
        type: 'function' as const,
        function: {
          name: checkEmailTool.function.name,
          description: checkEmailTool.function.description,
          parameters: checkEmailTool.function.parameters
        }
      },
      {
        type: 'function' as const,
        function: {
          name: openUrlTool.function.name,
          description: openUrlTool.function.description,
          parameters: openUrlTool.function.parameters
        }
      },
      {
        type: 'function' as const,
        function: {
          name: scrapeWebsiteTool.function.name,
          description: scrapeWebsiteTool.function.description,
          parameters: scrapeWebsiteTool.function.parameters
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
