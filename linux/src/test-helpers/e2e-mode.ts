import type { AgentState, VoiceTurnRequest } from '../shared/types';
import { ipcChannels } from '../shared/ipcChannels';
import { FakeWorkerApi, setFakeApiInstance, getFakeApiInstance, defaultFakeApiConfig } from './e2e-fake-api';
import type { WorkerApi } from '../main/workerApi';

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => any): void;
};

type BrowserWindowLike = {
  isDestroyed(): boolean;
  close(): void;
};

let e2eActive = false;

export function isE2EMode(): boolean {
  return process.env.CLICKY_E2E === '1';
}

export function enableE2EMode(): void {
  if (e2eActive) return;
  e2eActive = true;
}

export function disableE2EMode(): void {
  e2eActive = false;
}

export function createFakeWorkerApi(): FakeWorkerApi {
  const api = new FakeWorkerApi({ workerBaseUrl: 'http://localhost:0/e2e' });
  setFakeApiInstance(api);
  return api;
}

export function resolveWorkerApi(realApi: WorkerApi): WorkerApi {
  return isE2EMode() ? (getFakeApiInstance() as unknown as WorkerApi) : realApi;
}

export function registerE2EIpcHandlers(
  ipcMain: IpcMainLike,
  safeSend: (win: unknown, channel: string, ...args: unknown[]) => void,
  createOrbWindow: () => void,
  recorderWindowRef: () => BrowserWindowLike | undefined,
  recorderWindowReadyRef: () => boolean,
  agents: Map<string, any>,
): void {
  ipcMain.handle('e2e:isE2EMode', () => isE2EMode());

  ipcMain.handle('e2e:startRecordingFlow', async (_event: unknown, transcript: string) => {
    if (!isE2EMode()) {
      throw new Error('E2E mode is not enabled. Set CLICKY_E2E=1.');
    }

    const existingOrb = recorderWindowRef() as BrowserWindowLike | undefined;
    if (existingOrb && !existingOrb.isDestroyed()) {
      existingOrb.close();
    }

    createOrbWindow();

    await new Promise<void>((resolve) => {
      const check = () => {
        const w = recorderWindowRef() as BrowserWindowLike | undefined;
        if (w && !w.isDestroyed() && recorderWindowReadyRef()) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      setTimeout(check, 800);
    });

    const newOrb = recorderWindowRef() as BrowserWindowLike | undefined;
    if (!newOrb || newOrb.isDestroyed()) {
      throw new Error('Recorder window failed to open');
    }

    safeSend(newOrb, ipcChannels.recordingStart);

    await new Promise((r) => setTimeout(r, 500));

    safeSend(newOrb, ipcChannels.e2eInjectTranscript, transcript);
  });

  ipcMain.handle('e2e:getAgentStates', () => {
    const states: Record<string, AgentState> = {};
    for (const [id, entry] of agents) {
      states[id] = (entry as any).state as AgentState;
    }
    return states;
  });
}

export async function runE2EFakeAgentStream(
  state: AgentState,
  safeSend: (win: unknown, channel: string, ...args: unknown[]) => void,
  win: BrowserWindowLike,
): Promise<void> {
  const transcript = state.transcript.toLowerCase();
  const hasEmailRequest = transcript.includes('email') || transcript.includes('mail') || transcript.includes('inbox');

  if (hasEmailRequest) {
    state.commands.push('Checking emails...');
    safeSend(win, ipcChannels.agentCommandFlash, 'Checking emails...');
    safeSend(win, ipcChannels.agentUpdate, state);

    await new Promise((r) => setTimeout(r, 800));

    const emails = getFakeApiInstance()?.config?.seedEmails ?? defaultFakeApiConfig().seedEmails;
    state.emails = emails;
    safeSend(win, ipcChannels.agentUpdate, state);

    const finalResponse = getFakeApiInstance()?.config?.finalResponse ?? defaultFakeApiConfig().finalResponse;
    const cleanResponse = finalResponse.replace(/<<<HEADER>>>|<<<UI>>>|<<<SPOKEN>>>/g, '').replace(/\s+/g, ' ').trim();

    const chunks = chunkText(cleanResponse, 30);
    for (let i = 0; i < chunks.length; i++) {
      safeSend(win, ipcChannels.chatChunk, chunks[i]);
      if (i % 3 === 0) {
        state.response = chunks.slice(0, i + 1).join('');
        state.displayCaption = cleanResponse.slice(0, Math.min(160, (i + 1) * 30));
        safeSend(win, ipcChannels.agentUpdate, state);
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    state.status = 'done';
    state.response = cleanResponse;
    state.displayHeader = '3 recent emails found';
    state.displayCaption = cleanResponse.slice(0, 160);
    state.summary = cleanResponse.slice(0, 200);
    state.completedAt = Date.now();
    state.conversationHistory = [
      ...state.conversationHistory,
      { role: 'user', content: state.transcript },
      { role: 'assistant', content: cleanResponse }
    ];

    safeSend(win, ipcChannels.chatDone);
    safeSend(win, ipcChannels.agentUpdate, state);
    return;
  }

  safeSend(win, ipcChannels.agentCommandFlash, 'Processing...');
  state.commands.push('Processing...');
  safeSend(win, ipcChannels.agentUpdate, state);

  await new Promise((r) => setTimeout(r, 500));

  const genericResponse = "I understood your request: \"" + state.transcript + "\". This is an E2E test response.";
  for (const chunk of chunkText(genericResponse, 30)) {
    safeSend(win, ipcChannels.chatChunk, chunk);
    await new Promise((r) => setTimeout(r, 30));
  }

  state.status = 'done';
  state.response = genericResponse;
  state.displayHeader = 'Done';
  state.displayCaption = genericResponse.slice(0, 160);
  state.summary = genericResponse.slice(0, 200);
  state.completedAt = Date.now();

  safeSend(win, ipcChannels.chatDone);
  safeSend(win, ipcChannels.agentUpdate, state);
}

function chunkText(text: string, size: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    result.push(text.slice(i, i + size));
  }
  return result;
}
