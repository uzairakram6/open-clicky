export type VoiceState = 'idle' | 'listening' | 'processing' | 'responding';

export type AgentStatus = 'running' | 'done' | 'error';

export interface ShellResult {
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface EmailConfig {
  enabled: boolean;
  provider: 'gmail' | 'outlook' | 'yahoo' | 'custom';
  username: string;
  password: string;
  imapHost?: string;
  imapPort?: number;
}

export interface AppSettings {
  workerBaseUrl: string;
  model: string;
  selectedCaptureSourceId?: string;
  selectedCaptureSourceLabel?: string;
  onboarded: boolean;
  email?: EmailConfig;
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
  agentId?: string;
}

export interface ChatStreamEvent {
  type: 'chunk' | 'done' | 'error' | 'tool_call';
  text?: string;
  error?: string;
  name?: string;
  arguments?: string;
}

export interface CaptureSource {
  id: string;
  label: string;
  thumbnailDataUrl?: string;
}

export interface TranscribeTokenResponse {
  token: string;
  expiresAt: number;
  websocketUrl: string;
  model: "gpt-4o-mini-transcribe";
  sampleRate: 24000;
}

export interface RealtimeCallResponse {
  answerSdp: string;
  callId?: string;
}

export interface RecordedAudioPayload {
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface AgentAction {
  id: string;
  label: string;
  type: 'open_app' | 'open_folder' | 'open_url' | 'copy' | 'custom';
  payload?: string;
}

export interface EmailSummary {
  from: string;
  subject: string;
  date: string;
  preview: string;
  attachments: string[];
  uid: number;
}

export interface AgentState {
  id: string;
  status: AgentStatus;
  transcript: string;
  response: string;
  summary: string;
  commands: string[];
  actions: AgentAction[];
  error?: string;
  createdAt: number;
  completedAt?: number;
  model: string;
  conversationHistory: ConversationMessage[];
  captures: ScreenCapturePayload[];
  color?: string;
  emails?: EmailSummary[];
}

export interface WindowContext {
  type: 'recorder' | 'agent';
  agentId?: string;
  color?: string;
}
