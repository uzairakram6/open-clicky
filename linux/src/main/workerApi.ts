import { stripPointTags } from '../shared/pointTags';
import type { ChatStreamEvent, TranscribeTokenResponse, VoiceTurnRequest } from '../shared/types';
import { parseSseResponse } from './sse';

export interface WorkerApiConfig {
  workerBaseUrl: string;
}

export function buildChatPayload(request: VoiceTurnRequest) {
  return {
    transcript: request.transcript,
    captures: request.captures,
    model: request.model,
    conversationHistory: request.conversationHistory
  };
}

export class WorkerApi {
  constructor(private readonly config: WorkerApiConfig) {}

  async *sendTurn(request: VoiceTurnRequest): AsyncGenerator<ChatStreamEvent> {
    const response = await fetch(this.url('/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildChatPayload(request))
    });

    for await (const event of parseSseResponse(response)) {
      if (event.type === 'chunk' && event.text) {
        yield { ...event, text: stripPointTags(event.text) };
      } else {
        yield event;
      }
    }
  }

  async getTranscribeToken(): Promise<TranscribeTokenResponse> {
    const response = await fetch(this.url('/transcribe-token'), { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Unable to get transcription token: HTTP ${response.status}`);
    }
    return response.json() as Promise<TranscribeTokenResponse>;
  }

  async synthesizeSpeech(text: string): Promise<ArrayBuffer> {
    const response = await fetch(this.url('/tts'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: stripPointTags(text) })
    });

    if (!response.ok) {
      throw new Error(`Unable to synthesize speech: HTTP ${response.status}`);
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
