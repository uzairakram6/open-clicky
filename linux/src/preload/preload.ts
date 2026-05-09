import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels } from '../shared/ipcChannels';
import type { AppSettings, CaptureSource, ScreenCapturePayload, ShellResult, TranscribeTokenResponse, VoiceTurnRequest, WindowContext, AgentState, AgentAction, RecordedAudioPayload, RealtimeCallResponse, RealtimeToolRequest, RealtimeToolResponse } from '../shared/types';

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.settingsGet),
  setSettings: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.settingsSet, settings),
  selectScreens: (): Promise<CaptureSource[]> => ipcRenderer.invoke(ipcChannels.captureSelectScreen),
  setSelectedScreen: (source: CaptureSource): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.captureSetSelectedScreen, source),
  captureSelectedScreen: (): Promise<ScreenCapturePayload> => ipcRenderer.invoke(ipcChannels.captureTakeScreenshot),
  takeScreenshot: (): Promise<ScreenCapturePayload> => ipcRenderer.invoke(ipcChannels.captureTakeScreenshot),
  sendTurn: (request: VoiceTurnRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.chatSendTurn, request),
  transcribeAudio: (payload: RecordedAudioPayload): Promise<string> => ipcRenderer.invoke(ipcChannels.audioTranscribe, payload),
  getTranscribeToken: (): Promise<TranscribeTokenResponse> => ipcRenderer.invoke(ipcChannels.transcribeGetToken),
  createRealtimeCall: (offerSdp: string): Promise<RealtimeCallResponse> => ipcRenderer.invoke(ipcChannels.realtimeCreateCall, offerSdp),
  createRealtimeAgentCall: (offerSdp: string): Promise<RealtimeCallResponse> => ipcRenderer.invoke(ipcChannels.realtimeCreateAgentCall, offerSdp),
  executeRealtimeTool: (request: RealtimeToolRequest): Promise<RealtimeToolResponse> => ipcRenderer.invoke(ipcChannels.realtimeExecuteTool, request),
  speak: (text: string, agentId?: string): Promise<void> => ipcRenderer.invoke(ipcChannels.ttsSpeak, text, agentId),
  notifyRecordingStopped: (): void => ipcRenderer.send(ipcChannels.recordingStopped),
  spawnAgent: (request: VoiceTurnRequest): Promise<string> => ipcRenderer.invoke(ipcChannels.agentSpawn, request),
  spawnRealtimeAgent: (request: VoiceTurnRequest): Promise<string> => ipcRenderer.invoke(ipcChannels.agentSpawnRealtime, request),
  spawnAgentError: (message: string): Promise<string> => ipcRenderer.invoke(ipcChannels.agentSpawnError, message),
  closeAgent: (agentId: string): Promise<void> => ipcRenderer.invoke(ipcChannels.agentClose, agentId),
  getAgentState: (agentId: string): Promise<AgentState | undefined> => ipcRenderer.invoke(ipcChannels.agentGetContext, agentId),
  getWindowContext: (): Promise<WindowContext | undefined> => ipcRenderer.invoke(ipcChannels.windowGetContext),
  followUp: (agentId: string, request: VoiceTurnRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.agentFollowUp, agentId, request),
  runAgentAction: (action: AgentAction): Promise<void> => ipcRenderer.invoke(ipcChannels.agentRunAction, action),
  setAgentExpanded: (agentId: string, expanded: boolean): Promise<void> => ipcRenderer.invoke(ipcChannels.agentSetExpanded, agentId, expanded),
  reportAgentState: (state: AgentState, reason: string): void => ipcRenderer.send(ipcChannels.agentReportState, state, reason),
  reportAgentLogEvent: (agentId: string, type: string, details?: unknown): void => ipcRenderer.send(ipcChannels.agentLogEvent, agentId, type, details),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke(ipcChannels.openUrl, url),
  scrapeWebsite: (url: string): Promise<string> => ipcRenderer.invoke(ipcChannels.scrapeWebsite, url),
  onRecordingStart: (callback: () => void) => listen(ipcChannels.recordingStart, callback),
  onRecordingStop: (callback: () => void) => listen(ipcChannels.recordingStop, callback),
  onChatChunk: (callback: (text: string) => void) => listen(ipcChannels.chatChunk, callback),
  onChatDone: (callback: () => void) => listen(ipcChannels.chatDone, callback),
  onChatError: (callback: (error: string) => void) => listen(ipcChannels.chatError, callback),
  onTtsAudio: (callback: (audio: ArrayBuffer) => void) => listen(ipcChannels.ttsAudio, callback),
  onTtsStop: (callback: () => void) => listen(ipcChannels.ttsStop, callback),
  onTtsError: (callback: (error: string) => void) => listen(ipcChannels.ttsError, callback),
  onAgentUpdate: (callback: (state: AgentState) => void) => listen(ipcChannels.agentUpdate, callback),
  onAgentCommandFlash: (callback: (command: string) => void) => listen(ipcChannels.agentCommandFlash, callback),
  executeShell: (cmd: string): Promise<ShellResult> => ipcRenderer.invoke(ipcChannels.executeShell, cmd),
  sendCursorPosition: (x: number, y: number): void => ipcRenderer.send(ipcChannels.cursorPosition, x, y),
  e2e: {
    isE2EMode: (): Promise<boolean> => ipcRenderer.invoke(ipcChannels.e2eIsMode),
    isE2EModeSync: process.env.CLICKY_E2E === '1',
    startRecordingFlow: (transcript: string): Promise<void> => ipcRenderer.invoke(ipcChannels.e2eStartRecordingFlow, transcript),
    getAgentStates: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(ipcChannels.e2eGetAgentStates),
    onInjectTranscript: (callback: (text: string) => void) => listen(ipcChannels.e2eInjectTranscript, callback)
  }
};

contextBridge.exposeInMainWorld('clicky', api);

function listen<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: T) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

declare global {
  interface Window {
    clicky: typeof api;
  }
}
