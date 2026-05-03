import { contextBridge, ipcRenderer } from 'electron';
import { ipcChannels } from '../shared/ipcChannels';
import type { AppSettings, CaptureSource, ScreenCapturePayload, ShellResult, TranscribeTokenResponse, VoiceTurnRequest, WindowContext, AgentState, AgentAction, RecordedAudioPayload } from '../shared/types';

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.settingsGet),
  setSettings: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.settingsSet, settings),
  selectScreens: (): Promise<CaptureSource[]> => ipcRenderer.invoke(ipcChannels.captureSelectScreen),
  setSelectedScreen: (source: CaptureSource): Promise<AppSettings> => ipcRenderer.invoke(ipcChannels.captureSetSelectedScreen, source),
  captureSelectedScreen: (): Promise<ScreenCapturePayload> => captureSelectedScreen(),
  takeScreenshot: (): Promise<ScreenCapturePayload> => ipcRenderer.invoke(ipcChannels.captureTakeScreenshot),
  sendTurn: (request: VoiceTurnRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.chatSendTurn, request),
  transcribeAudio: (payload: RecordedAudioPayload): Promise<string> => ipcRenderer.invoke(ipcChannels.audioTranscribe, payload),
  getTranscribeToken: (): Promise<TranscribeTokenResponse> => ipcRenderer.invoke(ipcChannels.transcribeGetToken),
  speak: (text: string, agentId?: string): Promise<void> => ipcRenderer.invoke(ipcChannels.ttsSpeak, text, agentId),
  spawnAgent: (request: VoiceTurnRequest): Promise<string> => ipcRenderer.invoke(ipcChannels.agentSpawn, request),
  spawnAgentError: (message: string): Promise<string> => ipcRenderer.invoke(ipcChannels.agentSpawnError, message),
  closeAgent: (agentId: string): Promise<void> => ipcRenderer.invoke(ipcChannels.agentClose, agentId),
  getWindowContext: (): Promise<WindowContext | undefined> => ipcRenderer.invoke(ipcChannels.windowGetContext),
  followUp: (agentId: string, request: VoiceTurnRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.agentFollowUp, agentId, request),
  runAgentAction: (action: AgentAction): Promise<void> => ipcRenderer.invoke(ipcChannels.agentRunAction, action),
  onRecordingStart: (callback: () => void) => listen(ipcChannels.recordingStart, callback),
  onRecordingStop: (callback: () => void) => listen(ipcChannels.recordingStop, callback),
  onChatChunk: (callback: (text: string) => void) => listen(ipcChannels.chatChunk, callback),
  onChatDone: (callback: () => void) => listen(ipcChannels.chatDone, callback),
  onChatError: (callback: (error: string) => void) => listen(ipcChannels.chatError, callback),
  onTtsAudio: (callback: (audio: ArrayBuffer) => void) => listen(ipcChannels.ttsAudio, callback),
  onTtsError: (callback: (error: string) => void) => listen(ipcChannels.ttsError, callback),
  onAgentUpdate: (callback: (state: AgentState) => void) => listen(ipcChannels.agentUpdate, callback),
  onAgentCommandFlash: (callback: (command: string) => void) => listen(ipcChannels.agentCommandFlash, callback),
  executeShell: (cmd: string): Promise<ShellResult> => ipcRenderer.invoke(ipcChannels.executeShell, cmd)
};

contextBridge.exposeInMainWorld('clicky', api);

function listen<T extends unknown[]>(channel: string, callback: (...args: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, ...args: T) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

async function captureSelectedScreen(): Promise<ScreenCapturePayload> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false
  });

  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const width = settings.width ?? video.videoWidth;
    const height = settings.height ?? video.videoHeight;
    const scale = Math.min(1, 1280 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create capture canvas');
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);

    return {
      jpegBase64: dataUrl.replace(/^data:image\/jpeg;base64,/, ''),
      label: 'selected Linux screen',
      width: canvas.width,
      height: canvas.height
    };
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

declare global {
  interface Window {
    clicky: typeof api;
  }
}
