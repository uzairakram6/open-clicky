export type VoiceState = 'idle' | 'listening' | 'processing' | 'responding';

export interface AppSettings {
  workerBaseUrl: string;
  model: string;
  shortcut: string;
  selectedCaptureSourceId?: string;
  selectedCaptureSourceLabel?: string;
  onboarded: boolean;
}

export interface ScreenCapturePayload {
  jpegBase64: string;
  label: string;
  width: number;
  height: number;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface VoiceTurnRequest {
  transcript: string;
  captures: ScreenCapturePayload[];
  model: string;
  conversationHistory: ConversationMessage[];
}

export interface ChatStreamEvent {
  type: 'chunk' | 'done' | 'error';
  text?: string;
  error?: string;
}

export interface CaptureSource {
  id: string;
  label: string;
  thumbnailDataUrl?: string;
}

export interface TranscribeTokenResponse {
  token: string;
  expiresAt?: string;
}
