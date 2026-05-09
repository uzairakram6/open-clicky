import { homedir, tmpdir } from 'node:os';
import { stripPointTags, stripPointTagsPreserveWhitespace } from '../shared/pointTags';
import type { ChatStreamEvent, LlmTool, RealtimeCallResponse, TranscribeTokenResponse, VoiceTurnRequest } from '../shared/types';

export interface WorkerApiConfig {
  workerBaseUrl: string;
}

const DEFAULT_CHAT_COMPLETIONS_MODEL = 'gpt-5.4-mini';
const ENGLISH_TRANSCRIPTION_LANGUAGE = 'en';
const ENGLISH_TRANSCRIPTION_PROMPT =
  'Transcribe in English only. Do not translate into Urdu or output non-English script. If speech is unclear, choose the closest English words.';
const REALTIME_CALL_MAX_ATTEMPTS = 1;
const REALTIME_CALL_RETRY_BASE_MS = 700;
const REALTIME_CALL_TIMEOUT_MS = 3000;

export function isRealtimeModel(model: string | undefined): boolean {
  return /^gpt-realtime(?:$|-)/i.test((model ?? '').trim());
}

export function resolveChatCompletionsModel(model: string | undefined, fallback = DEFAULT_CHAT_COMPLETIONS_MODEL): string {
  const safeFallback = fallback && !isRealtimeModel(fallback) ? fallback : DEFAULT_CHAT_COMPLETIONS_MODEL;
  if (!model || isRealtimeModel(model)) return safeFallback;
  return model;
}

export function sanitizeOpenAIErrorBody(body: string): string {
  const compact = body
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return compact.slice(0, 500);
}

function isTransientOpenAIStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

export const downloadEmailAttachmentTool: LlmTool = {
  type: 'function',
  function: {
    name: 'download_email_attachment',
    description:
      'Download an attachment from a previously fetched email. Use this when the user asks to download an attachment from an email you have already listed. If email_number or filename is omitted, the app will resolve the latest clear attachment from runtime email context when possible.',
    parameters: {
      type: 'object',
      properties: {
        email_number: {
          type: 'number',
          description: 'The email number as shown in the previous check_email result (1 for the first email, 2 for the second, etc.)'
        },
        filename: {
          type: 'string',
          description: 'The exact filename of the attachment to download, including the extension.'
        }
      },
      required: []
    }
  }
};

export const readFileTool: LlmTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read text from a local file path, including downloaded attachments. Supports plain text, markdown, CSV, HTML, and DOCX documents. If path is omitted, the app will use an explicit absolute path from the user request or the last downloaded file when available.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the local file to read.'
        },
        max_chars: {
          type: 'number',
          description: 'Maximum number of characters to return. Default 12000.'
        }
      },
      required: []
    }
  }
};

export const openFileTool: LlmTool = {
  type: 'function',
  function: {
    name: 'open_file',
    description:
      'Open a local file with the user\'s default desktop application. If path is omitted, the app will use an explicit absolute path from the user request or the last downloaded file when available.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the local file to open.'
        }
      },
      required: []
    }
  }
};

export function buildOpenAITools(): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: LlmTool['function']['parameters'];
  };
}> {
  return [
    executeBashTool,
    writeFileTool,
    checkEmailTool,
    openUrlTool,
    scrapeWebsiteTool,
    downloadEmailAttachmentTool,
    readFileTool,
    openFileTool
  ].map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    }
  }));
}

export function buildClickySystemPrompt(): string {
  return 'You are Open Clicky, a friendly and focused Linux desktop AI assistant with TOOL ACCESS. You have tools for shell commands, writing files, email, URLs, website scraping, downloading email attachments, reading local files, and opening local files.\n\n' +
    'RUNTIME CONTEXT:\n' +
    '- You are running inside the Open Clicky desktop app on the user\'s machine.\n' +
    '- You are not a generic web chatbot. You have real tool access through the app.\n' +
    '- If a task can be done with one of your tools, do it. Do not give manual instructions instead.\n\n' +
    'PERSONALITY:\n' +
    '- You are helpful, warm, and approachable — like a knowledgeable coworker who genuinely wants to make the user\'s day easier.\n' +
    '- Keep responses concise and actionable. Avoid unnecessary fluff, but a little warmth goes a long way.\n' +
    '- Celebrate small wins. When something works, a quick "Done!" or "There you go" is great.\n' +
    '- If something fails, be honest and constructive: explain what happened and suggest a fix. No robotic apologies.\n' +
    '- Match the user\'s energy. If they\'re casual, be casual. If they\'re direct, be direct.\n\n' +
    'RULE 1: When the user asks about emails, inbox, messages, or mail — you MUST call the check_email tool. Do not answer from memory. Do not say you cannot access emails. The tool IS available and WILL work.\n\n' +
    'RULE 2: When the user asks about files, directories, system info, desktop cleanup, moving files, deleting files, or running commands — use the most specific file tool available. Prefer read_file for reading documents and open_file for opening documents. Use execute_bash_command for shell-only tasks and as an escape hatch. If the user asks to remove clutter, move the matching files to the system trash with gio trash when available. Do not create or use a dedicated declutter stash folder for cleanup. Do not permanently delete files unless the user explicitly asks for permanent deletion.\n\n' +
    'RULE 3: When the user asks to open a link, visit a website, or if you see a relevant URL in the screen context the user wants to visit — you MUST call the open_url tool.\n\n' +
    'RULE 4: When the user asks about content on a website, wants to summarize a page, or needs information from a web page — you MUST call the scrape_website tool.\n\n' +
    'RULE 5: When the user asks you to build an app, website, game, tool, or script, act as a practical software engineer: choose the simplest local technology, prefer one static HTML/CSS/JS file for websites and mini apps, use Python only when it is clearly useful, write files under /tmp/clicky_apps/<short-name>/ with write_file, then launch the result with execute_bash_command using xdg-open for HTML files or python3 for Python scripts. Keep generated apps minimal, functional, and demo-friendly.\n\n' +
    'RULE 6: When the user asks to download an attachment from an email you have already listed, call the download_email_attachment tool. If the user says "that file" or "the latest attachment", use the latest email attachment if the context makes it clear.\n\n' +
    'RULE 7: Never claim you cannot do something that a tool can do. Always use the appropriate tool.\n\n' +
    'RULE 8: Tool-task preamble protocol. If a tool call is needed, first provide exactly one short user-visible preamble that describes the concrete action you are about to perform, then immediately call the tool. Do not explain, suggest, or continue talking until the tool result is available.\n\n' +
    'RULE 9: Never provide manual steps for a task you can perform with a tool. For example, do not tell the user to sort files, open Finder, open Windows Explorer, right-click, or move files themselves when a tool can perform the operation.\n\n' +
    'RULE 10: If a screenshot or screen context is unavailable, say that directly and use other available tools or context instead of pretending to see the screen.\n\n' +
    'CRITICAL RULE — SPACING:\n' +
    'You MUST put a single space between EVERY word. Do not concatenate words. Do not omit spaces.\n\n' +
    `FILESYSTEM CONTEXT: The user's home directory is ${homedir()}, the temp directory is ${tmpdir()}, and the current working directory is ${process.cwd()}. Generated apps should be saved under /tmp/clicky_apps/. For other user-requested file work, use paths under the home directory or /tmp/. Never assume paths like /home/oai/share exist.`;
}

export function buildRealtimeAgentSession(): Record<string, unknown> {
  const realtimeInstructions = buildClickySystemPrompt() + '\n\n' +
    'REALTIME VOICE-SPECIFIC RULES:\n' +
    '# Preambles\n' +
    '- Preambles are short spoken updates before tool use, not hidden reasoning.\n' +
    '- For tool tasks, produce one natural preamble that describes the exact action, then call the tool immediately.\n' +
    '- Good preambles are concrete and brief, such as saying you are checking the relevant inbox, moving the requested files, opening the requested link, reading the requested page, or creating the requested app.\n' +
    '- Avoid generic filler such as "let me think", "please wait", "I can help you", or suggestions about what the user could do.\n' +
    '- Do not say "I can\'t access", "I can\'t control", "I can\'t move", or "I can only guide you" for email, files, URLs, websites, shell commands, or attachments. You have tools for those.\n' +
    '- Do not give suggestions before tool calls. If the user asks to clean files, check email, open a URL, or fetch a page, call the relevant tool instead of suggesting manual steps.\n' +
    '- After a tool result, give a concise result-only answer based on what actually happened.';

  return {
    type: 'realtime',
    model: 'gpt-realtime-2',
    instructions: realtimeInstructions,
    reasoning: { effort: 'medium' },
    audio: {
      input: {
        transcription: {
          model: 'gpt-realtime-whisper',
          language: ENGLISH_TRANSCRIPTION_LANGUAGE,
          prompt: ENGLISH_TRANSCRIPTION_PROMPT
        },
        noise_reduction: { type: 'near_field' },
        turn_detection: null
      },
      output: {
        voice: 'marin',
        format: { type: 'audio/pcm' }
      }
    },
    tools: [
      executeBashTool,
      writeFileTool,
      checkEmailTool,
      openUrlTool,
      scrapeWebsiteTool,
      downloadEmailAttachmentTool,
      readFileTool,
      openFileTool
    ].map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters
    })),
    tool_choice: 'auto'
  };
}

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
      buildClickySystemPrompt() + '\n\n' +
      'RESPONSE FORMAT (your final assistant message after tools — whenever you answer the user in natural language):\n' +
      'The desktop app speaks your reply with TTS, shows one line in the title bar, and one short caption in the body.\n' +
      'Split your closing reply exactly like this (literal markers, in order):\n\n' +
      '<<<HEADER>>>\n' +
      'Very short headline for the top bar (~6–48 characters). Readable words with normal spaces between every word. Describes what happened in plain language.\n' +
      '<<<UI>>>\n' +
      'One fuller caption for the modal body (max ~120 characters). Plain sentence case with a single space between every word. Summarize outcome for skim reading.\n' +
      '<<<SPOKEN>>>\n' +
      'Everything the user hears: full spoken explanation — warm, clear, detailed, with a single space between every word. Do not mention these markers or UI chrome.\n\n' +
      'Use this format only in your closing natural-language reply, not inside tool-call arguments.'
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

const DEBUG_OPENAI_STREAM = process.env.CLICKY_DEBUG_OPENAI_STREAM === '1';

function debugOpenAI(...args: unknown[]): void {
  if (DEBUG_OPENAI_STREAM) {
    console.log(...args);
  }
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
  const toolCallBuffers = new Map<string, { id: string; name: string; arguments: string }>();
  const toolCallOrder: string[] = [];
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
        console.log('[clicky:openai] [DONE] received. Tool buffers:', toolCallOrder.length);
        for (const id of toolCallOrder) {
          const toolCallBuffer = toolCallBuffers.get(id);
          if (!toolCallBuffer) continue;
          if (!toolCallBuffer.name) continue;
          console.log('[clicky:openai] Yielding tool_call:', toolCallBuffer.name, 'args:', toolCallBuffer.arguments);
          yield { type: 'tool_call', id: toolCallBuffer.id, name: toolCallBuffer.name, arguments: toolCallBuffer.arguments };
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
          for (let i = 0; i < delta.tool_calls.length; i++) {
            const tc = delta.tool_calls[i];
            debugOpenAI('[clicky:openai] Tool call delta:', JSON.stringify(tc));
            const key = tc.id ?? `idx-${i}`;
            let bufferForCall = toolCallBuffers.get(key);
            if (!bufferForCall) {
              bufferForCall = { id: key, name: '', arguments: '' };
              toolCallBuffers.set(key, bufferForCall);
              toolCallOrder.push(key);
            }
            if (tc.id) {
              bufferForCall.id = tc.id;
            }
            if (tc.function?.name) {
              if (!bufferForCall.name) {
                console.log('[clicky:openai] Tool call started:', tc.function.name);
              }
              bufferForCall.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              bufferForCall.arguments += tc.function.arguments;
            }
          }
        }
        if (delta?.content) {
          chunkCount++;
          debugOpenAI('[clicky:openai] Text chunk:', delta.content.slice(0, 100));
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
        console.log('[clicky:openai] [DONE] in tail. Tool buffers:', toolCallOrder.length);
        for (const id of toolCallOrder) {
          const toolCallBuffer = toolCallBuffers.get(id);
          if (!toolCallBuffer) continue;
          if (!toolCallBuffer.name) continue;
          console.log('[clicky:openai] Yielding tool_call from tail:', toolCallBuffer.name);
          yield { type: 'tool_call', id: toolCallBuffer.id, name: toolCallBuffer.name, arguments: toolCallBuffer.arguments };
        }
        yield { type: 'done' };
      }
    }
  }
}

export class WorkerApi {
  constructor(private readonly config: WorkerApiConfig) {}

  async *sendTurn(request: VoiceTurnRequest): AsyncGenerator<ChatStreamEvent> {
    const messages = buildOpenAIMessages(request);
    yield* this.sendMessages(messages, request.model);
  }

  async *sendMessages(messages: unknown[], model: string): AsyncGenerator<ChatStreamEvent> {
    const apiKey = getOpenAIApiKey();
    const tools = buildOpenAITools();

    const chatModel = resolveChatCompletionsModel(model);
    const requestBody = {
      model: chatModel,
      messages,
      stream: true,
      tools,
      tool_choice: 'auto' as const
    };

    console.log('[clicky:openai] Sending request. Model:', chatModel);
    if (chatModel !== model) {
      console.warn('[clicky:openai] Remapped non-chat model for Chat Completions:', {
        requestedModel: model,
        chatModel
      });
    }
    console.log('[clicky:openai] Tools registered:', tools.map(t => t.function.name).join(', '));
    debugOpenAI('[clicky:openai] Messages:', JSON.stringify(messages, null, 2));

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
      debugOpenAI('[clicky:openai] Yielding event:', event.type, event.type === 'chunk' ? event.text?.slice(0, 50) : '', event.type === 'tool_call' ? event.name : '');
      if (event.type === 'chunk' && event.text) {
        yield { ...event, text: stripPointTagsPreserveWhitespace(event.text) };
      } else {
        yield event;
      }
    }
  }

  async getTranscribeToken(): Promise<TranscribeTokenResponse> {
    const apiKey = getOpenAIApiKey();
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        expires_after: {
          anchor: 'created_at',
          seconds: 600
        },
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: {
                model: 'gpt-4o-mini-transcribe',
                language: ENGLISH_TRANSCRIPTION_LANGUAGE,
                prompt: ENGLISH_TRANSCRIPTION_PROMPT
              },
              noise_reduction: { type: 'near_field' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
              }
            }
          }
        }
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI realtime client_secrets failed: HTTP ${response.status} ${body}`);
    }

    const data = (await response.json()) as {
      value?: string;
      expires_at?: number | string;
    };

    if (typeof data.value !== 'string') {
      throw new Error('OpenAI realtime client_secrets response missing value');
    }

    let expiresAt: number;
    if (typeof data.expires_at === 'number') {
      expiresAt = data.expires_at;
    } else if (typeof data.expires_at === 'string') {
      expiresAt = Math.floor(new Date(data.expires_at).getTime() / 1000);
    } else {
      throw new Error('OpenAI realtime client_secrets response missing expires_at');
    }

    return {
      token: data.value,
      expiresAt,
      websocketUrl: 'wss://api.openai.com/v1/realtime',
      model: 'gpt-4o-mini-transcribe',
      sampleRate: 24000
    };
  }

  async createRealtimeTranscriptionCall(offerSdp: string): Promise<RealtimeCallResponse> {
    const apiKey = getOpenAIApiKey();
    const form = new FormData();
    form.set('sdp', offerSdp);
    form.set('session', new Blob([JSON.stringify({
      type: 'realtime',
      model: 'gpt-realtime',
      instructions: 'Transcribe the user audio in English only. Do not proactively answer unless a client event asks for a response.',
      audio: {
        input: {
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            language: ENGLISH_TRANSCRIPTION_LANGUAGE,
            prompt: ENGLISH_TRANSCRIPTION_PROMPT
          },
          noise_reduction: { type: 'near_field' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }
    })], { type: 'application/json' }));

    const response = await fetch('https://api.openai.com/v1/realtime/calls?model=gpt-realtime', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      },
      body: form
    });

    const answerSdp = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI realtime call failed: HTTP ${response.status} ${answerSdp}`);
    }

    return {
      answerSdp,
      callId: response.headers.get('location')?.split('/').filter(Boolean).pop() ?? undefined
    };
  }

  async createRealtimeAgentCall(offerSdp: string): Promise<RealtimeCallResponse> {
    const apiKey = getOpenAIApiKey();

    for (let attempt = 1; attempt <= REALTIME_CALL_MAX_ATTEMPTS; attempt += 1) {
      const form = new FormData();
      form.set('sdp', offerSdp);
      form.set('session', JSON.stringify(buildRealtimeAgentSession()));

      let response: Response;
      try {
        response = await fetchWithTimeout('https://api.openai.com/v1/realtime/calls?model=gpt-realtime-2', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`
          },
          body: form
        }, REALTIME_CALL_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[clicky:openai] realtime agent call request failed', {
          attempt,
          maxAttempts: REALTIME_CALL_MAX_ATTEMPTS,
          timeoutMs: REALTIME_CALL_TIMEOUT_MS,
          message
        });
        if (attempt < REALTIME_CALL_MAX_ATTEMPTS) {
          await wait(REALTIME_CALL_RETRY_BASE_MS * attempt);
          continue;
        }
        throw new Error(`OpenAI realtime agent call failed after ${attempt} attempts. ${message}`);
      }

      const answerSdp = await response.text();
      if (response.ok) {
        return {
          answerSdp,
          callId: response.headers.get('location')?.split('/').filter(Boolean).pop() ?? undefined
        };
      }

      const retryable = isTransientOpenAIStatus(response.status);
      const body = sanitizeOpenAIErrorBody(answerSdp);
      console.warn('[clicky:openai] realtime agent call failed', {
        status: response.status,
        attempt,
        maxAttempts: REALTIME_CALL_MAX_ATTEMPTS,
        retryable,
        body
      });
      if (retryable && attempt < REALTIME_CALL_MAX_ATTEMPTS) {
        await wait(REALTIME_CALL_RETRY_BASE_MS * attempt);
        continue;
      }
      throw new Error(
        `OpenAI realtime agent call failed: HTTP ${response.status}` +
        (retryable ? ` after ${attempt} attempts` : '') +
        (body ? `. ${body}` : '')
      );
    }

    throw new Error('OpenAI realtime agent call failed before a response was received');
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
