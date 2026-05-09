/**
 * Fake OpenAI / Worker API for E2E test mode.
 *
 * Returns deterministic responses without any network calls,
 * so Playwright E2E tests can run offline and predictably.
 */
import type { ChatStreamEvent, RealtimeCallResponse, TranscribeTokenResponse, VoiceTurnRequest, EmailSummary } from '../shared/types';
import type { WorkerApiConfig } from '../main/workerApi';
import { stripPointTags } from '../shared/pointTags';

export interface FakeApiConfig {
  /** The transcript to expect and match against */
  expectedTranscript?: string;
  /** Seeded emails returned by check_email tool */
  seedEmails?: EmailSummary[];
  /** Override for the final assistant response text */
  finalResponse?: string;
  /** Override for the tool call sequence */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

const DEFAULT_SEED_EMAILS: EmailSummary[] = [
  {
    from: 'Alice Johnson <alice@example.com>',
    subject: 'Q3 Budget Review',
    date: new Date(Date.now() - 3600000).toISOString(),
    preview: 'Hi team, please find attached the Q3 budget review documents. Let me know if you have any questions about the projections.',
    attachments: ['Q3_Budget.xlsx'],
    uid: 1001
  },
  {
    from: 'GitHub <noreply@github.com>',
    subject: '[clicky/linux-clicky] New pull request #42',
    date: new Date(Date.now() - 7200000).toISOString(),
    preview: 'A new pull request has been opened in clicky/linux-clicky by uzair. Title: Add E2E test infrastructure.',
    attachments: [],
    uid: 1002
  },
  {
    from: 'Bob Smith <bob@example.com>',
    subject: 'Meeting Notes - Sprint Planning',
    date: new Date(Date.now() - 86400000).toISOString(),
    preview: 'Here are the notes from today\'s sprint planning session. Action items are at the bottom.',
    attachments: [],
    uid: 1003
  }
];

export function defaultFakeApiConfig(): Required<Pick<FakeApiConfig, 'seedEmails' | 'finalResponse'>> {
  return {
    seedEmails: DEFAULT_SEED_EMAILS,
    finalResponse:
      '<<<HEADER>>>\n' +
      '3 recent emails found\n' +
      '<<<UI>>>\n' +
      'You have 3 recent emails. Alice sent a Q3 Budget Review, GitHub notified about PR #42, and Bob shared Sprint Planning notes.\n' +
      '<<<SPOKEN>>>\n' +
      "I checked your inbox and found 3 recent emails. The most recent is from Alice Johnson with the Q3 Budget Review — she attached a spreadsheet. Next is a GitHub notification about pull request #42 on the clicky repo. And Bob Smith sent over the sprint planning meeting notes. Would you like me to open any of these?"
  };
}

export class FakeWorkerApi {
  public config: FakeApiConfig;

  constructor(_workerConfig: WorkerApiConfig, fakeConfig: FakeApiConfig = {}) {
    this.config = fakeConfig;
  }

  async *sendTurn(request: VoiceTurnRequest): AsyncGenerator<ChatStreamEvent> {
    const transcript = request.transcript.toLowerCase();

    // If the transcript mentions emails or checking inbox, return check_email tool call
    if (transcript.includes('email') || transcript.includes('mail') || transcript.includes('inbox')) {
      // Only call check_email if the request is the first turn (not a tool result follow-up)
      const isFirstTurn = request.conversationHistory.length === 0;
      const isToolResult = transcript.startsWith('Here are the recent emails:');

      if (isFirstTurn && !isToolResult) {
        // First turn: emit check_email tool call
        yield {
          type: 'tool_call',
          name: 'check_email',
          arguments: JSON.stringify({ count: 5 })
        };
        return;
      }

      if (isToolResult) {
        // Tool result turn: emit the final response
        const emails = this.config.seedEmails ?? defaultFakeApiConfig().seedEmails;
        const finalResponse = this.config.finalResponse ?? defaultFakeApiConfig().finalResponse;

        // Simulate streaming the response character by character
        const chunks = chunkText(stripPointTags(finalResponse), 20);
        for (const chunk of chunks) {
          yield { type: 'chunk', text: chunk };
        }
        yield { type: 'done' };
        return;
      }
    }

    // Default: just return done with empty response
    const defaultResponse = this.config.finalResponse ?? defaultFakeApiConfig().finalResponse;
    const chunks = chunkText(stripPointTags(defaultResponse), 20);
    for (const chunk of chunks) {
      yield { type: 'chunk', text: chunk };
    }
    yield { type: 'done' };
  }

  async *sendMessages(messages: unknown[]): AsyncGenerator<ChatStreamEvent> {
    const toolMessages = messages.filter((message): message is { role: string; content?: unknown } => {
      return typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'tool';
    });
    const latestToolContent = String(toolMessages.at(-1)?.content ?? '');
    if (latestToolContent) {
      const response = latestToolContent.includes('File written successfully:')
        ? '<<<HEADER>>>\nWebsite built\n<<<UI>>>\nThe website was written and opened in a browser tab.\n<<<SPOKEN>>>\nI built the website and opened it in a browser tab.'
        : latestToolContent.includes('Email #')
        ? (this.config.finalResponse ?? defaultFakeApiConfig().finalResponse)
        : '<<<HEADER>>>\nTool completed\n<<<UI>>>\nThe requested tool action completed.\n<<<SPOKEN>>>\nThe requested tool action completed. Tool output: ' + latestToolContent.slice(0, 500);
      for (const chunk of chunkText(stripPointTags(response), 20)) {
        yield { type: 'chunk', text: chunk };
      }
      yield { type: 'done' };
      return;
    }

    const lastUser = [...messages].reverse().find((message): message is { role: string; content?: unknown } => {
      return typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'user';
    });
    const content = Array.isArray(lastUser?.content)
      ? lastUser.content.map((part) => typeof part === 'object' && part !== null && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '').join(' ')
      : String(lastUser?.content ?? '');
    if (/\b(build|make|create|generate|turn|convert|transform)\b/i.test(content) && /\b(website|site|landing page|web page)\b/i.test(content)) {
      yield {
        type: 'tool_call',
        id: 'fake-empty-write-file-call',
        name: 'write_file',
        arguments: JSON.stringify({})
      };
      yield { type: 'done' };
      return;
    }
    const openFileMatch = content.match(/\/tmp\/clicky-e2e-[^\s"'`]+\.txt/);
    if (/\b(open|launch|view)\b/i.test(content) && openFileMatch) {
      yield {
        type: 'tool_call',
        id: 'fake-open-file-call',
        name: 'open_file',
        arguments: JSON.stringify({})
      };
      yield { type: 'done' };
      return;
    }
    const readFileMatch = content.match(/\/tmp\/clicky-e2e-[^\s"'`]+\.txt/);
    if (readFileMatch) {
      yield {
        type: 'tool_call',
        id: 'fake-read-file-call',
        name: 'read_file',
        arguments: JSON.stringify({})
      };
      yield { type: 'done' };
      return;
    }
    if (content.includes('/tmp/clicky-e2e-terminal-action')) {
      yield {
        type: 'tool_call',
        id: 'fake-terminal-shell-call',
        name: 'execute_bash_command',
        arguments: JSON.stringify({
          command: 'mkdir -p /tmp/clicky-e2e-terminal-action && printf "Created /tmp/clicky-e2e-terminal-action"'
        })
      };
      yield { type: 'done' };
      return;
    }
    yield* this.sendTurn({
      transcript: content,
      captures: [],
      model: 'fake-e2e-model',
      conversationHistory: []
    });
  }

  async getTranscribeToken(): Promise<TranscribeTokenResponse> {
    return {
      token: 'fake-e2e-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      websocketUrl: 'wss://fake-e2e.local/realtime',
      model: 'gpt-4o-mini-transcribe',
      sampleRate: 24000
    };
  }

  async createRealtimeTranscriptionCall(_offerSdp: string): Promise<RealtimeCallResponse> {
    return {
      answerSdp: 'v=0\r\no=fake-e2e 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
      callId: 'fake-e2e-transcription-call'
    };
  }

  async createRealtimeAgentCall(_offerSdp: string): Promise<RealtimeCallResponse> {
    return {
      answerSdp: 'v=0\r\no=fake-e2e 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
      callId: 'fake-e2e-agent-call'
    };
  }

  async synthesizeSpeech(_text: string): Promise<ArrayBuffer> {
    // Return a tiny valid WAV file (44 bytes header + 0 bytes data)
    const sampleRate = 24000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const dataSize = 0;
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize);
    const view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, headerSize + dataSize - 8, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
    view.setUint16(32, numChannels * bitsPerSample / 8, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    return buffer;
  }
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function chunkText(text: string, size: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    result.push(text.slice(i, i + size));
  }
  return result;
}

/** Singleton reference for the main-process E2E handler */
let _fakeApiInstance: FakeWorkerApi | undefined;

export function setFakeApiInstance(api: FakeWorkerApi): void {
  _fakeApiInstance = api;
}

export function getFakeApiInstance(): FakeWorkerApi | undefined {
  return _fakeApiInstance;
}
