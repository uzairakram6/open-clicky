export const ipcChannels = {
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
} as const;
