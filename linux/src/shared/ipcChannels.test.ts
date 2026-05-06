import { describe, expect, it } from 'vitest';
import { ipcChannels } from './ipcChannels';

describe('IPC channel contract', () => {
  it('defines the renderer/main channels used by Clicky V1', () => {
    expect(ipcChannels).toEqual({
      settingsGet: 'settings:get',
      settingsSet: 'settings:set',
      captureSelectScreen: 'capture:selectScreen',
      captureSetSelectedScreen: 'capture:setSelectedScreen',
      captureTakeScreenshot: 'capture:takeScreenshot',
      chatSendTurn: 'chat:sendTurn',
      audioTranscribe: 'audio:transcribe',
      transcribeGetToken: 'transcribe:getToken',
      realtimeCreateCall: 'realtime:createCall',
      ttsSpeak: 'tts:speak',
      recordingStart: 'recording:start',
      recordingStop: 'recording:stop',
      recordingStopped: 'recording:stopped',
      chatChunk: 'chat:chunk',
      chatDone: 'chat:done',
      chatError: 'chat:error',
      ttsAudio: 'tts:audio',
      ttsError: 'tts:error',
      agentSpawn: 'agent:spawn',
      agentSpawnError: 'agent:spawnError',
      agentClose: 'agent:close',
      agentGetContext: 'agent:getContext',
      agentCommandFlash: 'agent:commandFlash',
      agentUpdate: 'agent:update',
      agentFollowUp: 'agent:followUp',
      agentRunAction: 'agent:runAction',
      agentSetExpanded: 'agent:setExpanded',
      windowGetContext: 'window:getContext',
      executeShell: 'shell:execute',
      openUrl: 'open-url',
      scrapeWebsite: 'scrape:website'
    });
  });
});
