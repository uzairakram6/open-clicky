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
      realtimeCreateAgentCall: 'realtime:createAgentCall',
      realtimeExecuteTool: 'realtime:executeTool',
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
      agentSpawnRealtime: 'agent:spawnRealtime',
      agentSpawnError: 'agent:spawnError',
      agentClose: 'agent:close',
      agentGetContext: 'agent:getContext',
      agentCommandFlash: 'agent:commandFlash',
      agentUpdate: 'agent:update',
      agentFollowUp: 'agent:followUp',
      agentRunAction: 'agent:runAction',
      agentSetExpanded: 'agent:setExpanded',
      agentReportState: 'agent:reportState',
      agentLogEvent: 'agent:logEvent',
      windowGetContext: 'window:getContext',
      executeShell: 'shell:execute',
      openUrl: 'open-url',
      scrapeWebsite: 'scrape:website',
      cursorPosition: 'cursor:position',
      e2eIsMode: 'e2e:isE2EMode',
      e2eStartRecordingFlow: 'e2e:startRecordingFlow',
      e2eGetAgentStates: 'e2e:getAgentStates',
      e2eInjectTranscript: 'e2e:injectTranscript'
    });
  });
});
