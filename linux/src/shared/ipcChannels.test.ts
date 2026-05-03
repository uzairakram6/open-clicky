import { describe, expect, it } from 'vitest';
import { ipcChannels } from './ipcChannels';

describe('IPC channel contract', () => {
  it('defines the renderer/main channels used by Clicky V1', () => {
    expect(ipcChannels).toEqual({
      settingsGet: 'settings:get',
      settingsSet: 'settings:set',
      captureSelectScreen: 'capture:selectScreen',
      captureSetSelectedScreen: 'capture:setSelectedScreen',
      chatSendTurn: 'chat:sendTurn',
      transcribeGetToken: 'transcribe:getToken',
      ttsSpeak: 'tts:speak',
      voiceToggle: 'voice:toggle',
      chatChunk: 'chat:chunk',
      chatDone: 'chat:done',
      chatError: 'chat:error',
      ttsAudio: 'tts:audio',
      ttsError: 'tts:error'
    });
  });
});
