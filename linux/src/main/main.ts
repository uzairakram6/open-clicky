import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSettings, saveSettings } from './settings';
import { WorkerApi } from './workerApi';
import { scrapeWebsite } from './scraper';
import { ipcChannels } from '../shared/ipcChannels';
import { buildTaskAcknowledgement, cleanAcknowledgementSpeech } from '../shared/acknowledgement';
import type { AppSettings, CaptureSource, VoiceTurnRequest, AgentState, WindowContext, AgentAction, ScreenCapturePayload, ShellResult, RecordedAudioPayload, EmailSummary, TranscribeTokenResponse } from '../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const TOGGLE_RECORDER_ARG = '--clicky-toggle-recorder';
const GNOME_CLICKY_SHORTCUT_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/clicky-toggle/';

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

const waylandSession = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
if (waylandSession) {
  process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('disable-features', 'GlobalShortcutsPortal');
  console.log('[clicky:main] detected Wayland session, forcing XWayland/X11 global shortcut backend');
}

app.commandLine.appendSwitch('no-sandbox');

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let envLoaded = false;
let tray: Tray | undefined;
let settings: AppSettings;
let recorderWindow: BrowserWindow | undefined;
let recorderWindowReady = false;
let cursorTrackingInterval: NodeJS.Timeout | undefined;
let keepAliveWindow: BrowserWindow | undefined;
let keepAliveTimer: NodeJS.Timeout | undefined;
let cachedTranscribeToken: { value: Awaited<ReturnType<WorkerApi['getTranscribeToken']>>; fetchedAt: number } | undefined;
let pendingTranscribeToken: Promise<TranscribeTokenResponse> | undefined;
const agents = new Map<string, { window: BrowserWindow; state: AgentState; expanded: boolean }>();
const windowContexts = new Map<number, WindowContext>();
const agentWindowMetrics = {
  miniWidth: 52,
  miniHeight: 52,
  expandedWidth: 340,
  expandedHeight: 420,
  margin: 18,
  stackGap: 10
};
const CLICKY_APPS_DIR = resolve(tmpdir(), 'clicky_apps');
const AGENT_COLORS = ['#FFD60A', '#FF453A', '#0A84FF', '#BF5AF2'];
const assignedAgentColors = new Map<string, string>();
const CHAT_CHUNK_FLUSH_MS = 50;
const CHAT_CHUNK_MAX_CHARS = 160;
const LOCAL_SPEECH_MAX_CHARS = 1200;

function safeSend(win: BrowserWindow | undefined, channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

function createChatChunkFlusher(win: BrowserWindow): { append: (text: string) => void; flush: () => void; dispose: () => void } {
  let pending = '';
  let timer: NodeJS.Timeout | undefined;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!pending) return;
    const text = pending;
    pending = '';
    safeSend(win, ipcChannels.chatChunk, text);
  };

  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(flush, CHAT_CHUNK_FLUSH_MS);
    timer.unref();
  };

  return {
    append: (text: string) => {
      pending += text;
      if (pending.length >= CHAT_CHUNK_MAX_CHARS) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
    dispose: flush
  };
}

function normalizeSpeechText(text: string): string {
  return cleanAcknowledgementSpeech(text, LOCAL_SPEECH_MAX_CHARS).replace(/\s+/g, ' ').trim();
}

async function speakWithSystemTts(text: string): Promise<boolean> {
  const engines = [
    { command: 'spd-say', args: (value: string) => [value] },
    { command: 'espeak-ng', args: (value: string) => [value] },
    { command: 'espeak', args: (value: string) => [value] }
  ];

  for (const engine of engines) {
    try {
      await execFileAsync(engine.command, engine.args(text), { timeout: 3000 });
      console.log('[clicky:tts] system speech requested', { engine: engine.command, chars: text.length });
      return true;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
      if (code !== 'ENOENT') {
        console.warn('[clicky:tts] system speech failed', {
          engine: engine.command,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  return false;
}

function speakWithBrowserSpeech(win: BrowserWindow, text: string): Promise<boolean> {
  return win.webContents.executeJavaScript(`
    (() => {
      if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
        return false;
      }
      const utterance = new SpeechSynthesisUtterance(${JSON.stringify(text)});
      utterance.rate = 1.08;
      utterance.pitch = 1;
      utterance.volume = 1;
      window.speechSynthesis.speak(utterance);
      return true;
    })();
  `, true) as Promise<boolean>;
}

async function speakTextLocally(win: BrowserWindow, text: string): Promise<boolean> {
  const speechText = normalizeSpeechText(text);
  if (!speechText) {
    return false;
  }

  if (await speakWithSystemTts(speechText)) {
    return true;
  }

  return speakWithBrowserSpeech(win, speechText);
}

function speakWithOpenAiInBackground(api: WorkerApi, win: BrowserWindow, agentId: string, text: string, reason: 'acknowledgement' | 'response'): void {
  void (async () => {
    const speechText = normalizeSpeechText(stripPointTagsForSpeech(text));
    if (!speechText) return;

    try {
      console.log('[clicky:agent] requesting OpenAI speech', { agentId, reason, chars: speechText.length });
      const audio = await api.synthesizeSpeech(speechText);
      if (reason === 'acknowledgement' && agents.get(agentId)?.state.status !== 'running') {
        console.log('[clicky:agent] skipped stale acknowledgement speech', { agentId });
        return;
      }
      safeSend(win, ipcChannels.ttsAudio, audio);
      console.log('[clicky:agent] OpenAI speech audio sent', { agentId, reason, bytes: audio.byteLength });
    } catch (error) {
      console.warn('[clicky:agent] OpenAI speech failed; falling back to local speech', {
        agentId,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
      try {
        await speakTextLocally(win, speechText);
      } catch {
        void 0;
      }
    }
  })();
}

function waitForWindowLoad(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || !win.webContents.isLoading()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      win.webContents.off('did-finish-load', finish);
      win.webContents.off('did-fail-load', finish);
      win.off('closed', finish);
      resolve();
    };

    win.webContents.once('did-finish-load', finish);
    win.webContents.once('did-fail-load', finish);
    win.once('closed', finish);
    timeout = setTimeout(finish, 5000);
    timeout.unref();
  });
}

function speakTaskAcknowledgement(api: WorkerApi, win: BrowserWindow, agentId: string, transcript: string): void {
  const acknowledgement = buildTaskAcknowledgement(transcript);
  speakWithOpenAiInBackground(api, win, agentId, acknowledgement, 'acknowledgement');
}

function stripPointTagsForSpeech(text: string): string {
  return text.replace(/<point\b[^>]*>.*?<\/point>/gis, '').trim();
}

function stopCursorTracking(reason: string): void {
  if (!cursorTrackingInterval) return;
  clearInterval(cursorTrackingInterval);
  cursorTrackingInterval = undefined;
  console.log('[clicky:orb] cursor tracking interval cleared', { reason });
}

function getOrbCursorBounds(width: number, height: number): { x: number; y: number; cursor: Electron.Point; displayId: number } {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = display.workArea;
  const offset = 14;

  const x = Math.max(bounds.x, Math.min(cursor.x + offset, bounds.x + bounds.width - width));
  const y = Math.max(bounds.y, Math.min(cursor.y + offset, bounds.y + bounds.height - height));

  return { x, y, cursor, displayId: display.id };
}

function pickAgentColor(): string {
  const used = new Set(assignedAgentColors.values());
  const available = AGENT_COLORS.filter((c) => !used.has(c));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  return AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)];
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  console.log('[clicky:main] another Clicky instance is already running; exiting this launcher process');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const source = argv.includes(TOGGLE_RECORDER_ARG) ? 'gnome-custom-shortcut' : 'second-instance';
    if (app.isReady()) {
      handlePushToTalkTrigger(source);
    } else {
      void app.whenReady().then(() => handlePushToTalkTrigger(source));
    }
  });
}

async function initApp(): Promise<void> {
  console.log('[clicky:main] app init started');
  await loadDotEnv();
  settings = await loadSettings();
  console.log('[clicky:main] settings loaded', {
    workerBaseUrl: settings.workerBaseUrl,
    model: settings.model,
    selectedCaptureSourceLabel: settings.selectedCaptureSourceLabel,
    email: summarizeEmailConfig(settings.email)
  });
  void getCachedTranscribeToken().catch((error) => {
    console.warn('[clicky:transcribe] realtime token prefetch failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    console.log('[clicky:capture] display media requested');
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } }).then((sources) => {
      const source = sources.find((item) => item.id === settings.selectedCaptureSourceId) ?? sources[0];
      console.log('[clicky:capture] display media source selected', {
        availableSources: sources.length,
        selected: source?.name
      });
      callback(source ? { video: source, audio: 'loopback' } : {});
    });
  }, { useSystemPicker: false });

  createKeepAliveWindow();
  createTray();
  registerPushToTalkShortcut();

  if (process.argv.includes(TOGGLE_RECORDER_ARG)) {
    console.log('[clicky:hotkey] toggle argument detected on startup');
    openRecorderOrb();
  }
  console.log('[clicky:main] app init complete; resident process active');
  void registerGnomeWaylandShortcut();
}

function createKeepAliveWindow(): void {
  if (keepAliveWindow && !keepAliveWindow.isDestroyed()) return;

  keepAliveWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  keepAliveWindow.on('closed', () => {
    keepAliveWindow = undefined;
  });
  keepAliveTimer ??= setInterval(() => {
    void 0;
  }, 60_000);
  console.log('[clicky:main] keep-alive window created');
}

function createTray(): void {
  try {
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAxklEQVR4nJ2TsQ3CMAxF3w0wARsQG7ACG7ABG7ABG7ABG7ABG7ABG7ABG1AQEmioUqRKkZzYTvb9+66fYAIz6wVcAE6Bm8A84GgAdwUTYAG8Avc8y0bB3wJNgcZJY1MFXgP7GNcAUWAvkU2bmQEcA49knu8D1QU+knkVAhvJLJ8k2QX4QmZ5JsmDgGuS7AQ8AvuZ5zW5rQT2Emkb7XVQo7XRNE0doKx9FUQQnJTp3A3wDTcxdYvVw/Rm3AAAAAElFTkSuQmCC'
    );
      tray = new Tray(icon);
    if (!tray.isDestroyed()) {
      tray.setToolTip('Clicky');
      tray.on('click', () => {
        console.log('[clicky:tray] tray clicked; opening recorder orb');
        openRecorderOrb();
      });
      updateTrayMenu();
      console.log('[clicky:tray] tray created');
    }
  } catch (err) {
    console.error('[clicky:tray] tray creation failed:', err);
    tray = undefined;
  }
}

function updateTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Settings', click: () => console.log('Settings not yet implemented') },
      { label: 'Open Clicky Recorder', click: openRecorderOrb },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
  } catch (err) {
    console.error('[clicky:tray] tray menu update failed:', err);
  }
}

function openRecorderOrb(): void {
  console.log('[clicky:hotkey] push-to-talk triggered; opening recorder orb');
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    console.warn('[clicky:hotkey] recorder orb is already open; ignoring hotkey');
    return;
  }
  recorderWindowReady = false;
  createOrbWindow();
}

function handlePushToTalkTrigger(source: string): void {
  console.log('[clicky:hotkey] push-to-talk triggered', { source });
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    if (recorderWindowReady) {
      safeSend(recorderWindow, ipcChannels.recordingStop);
      console.log('[clicky:hotkey] stop recording sent to orb', { source });
    }
    stopCursorTracking('hotkey-stop');
    return;
  }
  openRecorderOrb();
}

function createOrbWindow(): void {
  const width = 80;
  const height = 40;
  const initialBounds = getOrbCursorBounds(width, height);

  console.log('[clicky:orb] creating orb window', {
    cursor: initialBounds.cursor,
    display: initialBounds.displayId,
    x: initialBounds.x,
    y: initialBounds.y,
    width,
    height
  });

  const win = new BrowserWindow({
    width,
    height,
    x: initialBounds.x,
    y: initialBounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  recorderWindow = win;

  const winId = win.webContents.id;
  windowContexts.set(winId, { type: 'recorder' });
  console.log('[clicky:orb] window context registered', { winId });

  const loadPromise = process.env.VITE_DEV_SERVER_URL
    ? win.loadURL(process.env.VITE_DEV_SERVER_URL)
    : win.loadFile(join(__dirname, '../renderer/index.html'));

  void loadPromise.then(() => {
    console.log('[clicky:orb] renderer loaded');
    if (!win.isDestroyed()) {
      win.show();
      win.setIgnoreMouseEvents(true);
      recorderWindowReady = true;

      stopCursorTracking('restart-before-follow');
      cursorTrackingInterval = setInterval(() => {
        if (win.isDestroyed()) return;
        const nextBounds = getOrbCursorBounds(width, height);
        const currentBounds = win.getBounds();
        if (currentBounds.x !== nextBounds.x || currentBounds.y !== nextBounds.y) {
          win.setBounds({ x: nextBounds.x, y: nextBounds.y, width, height }, false);
        }
      }, 16);
      console.log('[clicky:orb] cursor tracking interval started');

      // Delay the start message so React has time to mount and register IPC listeners
      setTimeout(() => {
        if (!win.isDestroyed()) {
          safeSend(win, ipcChannels.recordingStart);
          console.log('[clicky:orb] window shown and recording start sent');
        }
      }, 300);
    }
  }).catch((err) => {
    console.error('[clicky:orb] renderer load failed:', err);
  });

  win.on('closed', () => {
    stopCursorTracking('window-closed');
    windowContexts.delete(winId);
    recorderWindow = undefined;
    recorderWindowReady = false;
    console.log('[clicky:orb] window closed and context removed', { winId });
  });
}

function createAgentWindow(agentId: string): BrowserWindow {
  const color = pickAgentColor();
  assignedAgentColors.set(agentId, color);

  const primary = screen.getPrimaryDisplay();
  const { miniWidth: width, miniHeight: height, margin, stackGap } = agentWindowMetrics;
  const x = primary.workArea.x + primary.workArea.width - width - margin;
  const y = primary.workArea.y + margin + (agents.size * (height + stackGap));
  console.log('[clicky:agent] creating agent window', { agentId, x, y, width, height, color });

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    title: 'Clicky Agent',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  const winId = win.webContents.id;
  windowContexts.set(winId, { type: 'agent', agentId, color });
  console.log('[clicky:agent] window context registered', { agentId, winId, color });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.once('ready-to-show', () => {
    win.show();
    console.log('[clicky:agent] window ready and shown', { agentId });
  });

  win.on('closed', () => {
    agents.delete(agentId);
    assignedAgentColors.delete(agentId);
    windowContexts.delete(winId);
    console.log('[clicky:agent] window closed and state removed', { agentId, winId });
  });

  return win;
}

function setAgentWindowExpanded(agentId: string, expanded: boolean): void {
  const entry = agents.get(agentId);
  if (!entry || entry.window.isDestroyed()) return;

  entry.expanded = expanded;
  const display = screen.getDisplayNearestPoint(entry.window.getBounds());
  const { miniWidth, miniHeight, expandedWidth, expandedHeight, margin } = agentWindowMetrics;
  const width = expanded ? expandedWidth : miniWidth;
  const height = expanded ? expandedHeight : miniHeight;
  const current = entry.window.getBounds();
  const x = display.workArea.x + display.workArea.width - width - margin;
  const y = Math.max(display.workArea.y + margin, current.y);

  entry.window.setBounds({ x, y, width, height }, true);
}

function buildDefaultActions(transcript: string, commands: string[] = [], emails?: EmailSummary[]): AgentAction[] {
  const actions: AgentAction[] = [{ id: 'copy', label: 'Copy Response', type: 'copy' }];
  const generatedAppPath = findGeneratedAppPath(commands);
  if (generatedAppPath) {
    actions.push({ id: 'open-generated-app', label: 'Open App', type: 'open_folder', payload: generatedAppPath });
  }
  if (transcript.toLowerCase().includes('reminder')) {
    actions.push({ id: 'open-reminders', label: 'Open Reminders', type: 'open_app', payload: 'reminders' });
  }
  if (transcript.toLowerCase().includes('desktop') || transcript.toLowerCase().includes('file') || transcript.toLowerCase().includes('folder')) {
    actions.push({ id: 'open-folder', label: 'Open Folder', type: 'open_folder', payload: app.getPath('desktop') });
  }
  if (emails) {
    for (const email of emails) {
      for (const filename of email.attachments) {
        actions.push({
          id: `download-attachment-${email.uid}-${filename}`,
          label: `Download ${filename}`,
          type: 'custom',
          payload: JSON.stringify({ type: 'download_email_attachment', uid: email.uid, filename })
        });
      }
    }
  }
  return actions;
}

function findGeneratedAppPath(commands: string[]): string | undefined {
  for (const command of commands.slice().reverse()) {
    const htmlMatch = command.match(/\/tmp\/clicky_apps\/[^\s'"`]+\.html\b/);
    if (htmlMatch) return htmlMatch[0];
  }
  for (const command of commands.slice().reverse()) {
    const pathMatch = command.match(/\/tmp\/clicky_apps\/[^\s'"`]+/);
    if (pathMatch) return pathMatch[0];
  }
  return undefined;
}

function createErrorAgent(message: string): string {
  const agentId = randomUUID();
  console.log('[clicky:agent] creating error agent', { agentId, message });
  const win = createAgentWindow(agentId);
  const color = assignedAgentColors.get(agentId);
  const state: AgentState = {
    id: agentId,
    status: 'error',
    transcript: 'Voice command',
    response: '',
    summary: '',
    commands: [],
    actions: [],
    error: message,
    model: settings.model,
    conversationHistory: [],
    captures: [],
    createdAt: Date.now(),
    completedAt: Date.now(),
    color
  };

  agents.set(agentId, { window: win, state, expanded: false });
  win.webContents.on('did-finish-load', () => {
    console.log('[clicky:agent] sending error state to renderer', { agentId });
    safeSend(win, ipcChannels.agentUpdate, state);
    safeSend(win, ipcChannels.chatError, message);
  });
  return agentId;
}

async function transcribeWithWhisper(audio: RecordedAudioPayload): Promise<string> {
  console.log('[clicky:whisper] transcription requested', {
    bytes: audio.bytes.byteLength,
    mimeType: audio.mimeType
  });
  const apiKey = await getOpenAiApiKey();
  const extension = extensionForMimeType(audio.mimeType);
  const audioPath = join(tmpdir(), `clicky-${randomUUID()}${extension}`);
  const bytes = Buffer.from(audio.bytes);

  await writeFile(audioPath, bytes);
  console.log('[clicky:whisper] temp audio file written', {
    path: audioPath,
    bytes: bytes.length
  });
  try {
    const fileBytes = await readFile(audioPath);
    const form = new FormData();
    form.append('model', 'gpt-4o-transcribe');
    form.append('file', new Blob([fileBytes], { type: audio.mimeType || 'audio/webm' }), `clicky${extension}`);

    console.log('[clicky:whisper] sending audio to OpenAI transcription endpoint');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`
      },
      body: form
    });

    if (!response.ok) {
      console.error('[clicky:whisper] OpenAI transcription failed', {
        status: response.status,
        statusText: response.statusText
      });
      throw new Error(`Whisper transcription failed: HTTP ${response.status}`);
    }

    const payload = await response.json() as { text?: string };
    if (!payload.text) {
      console.error('[clicky:whisper] OpenAI response did not include text');
      throw new Error('Whisper transcription returned no text');
    }
    console.log('[clicky:whisper] transcription completed', {
      chars: payload.text.length
    });
    return payload.text;
  } finally {
    await unlink(audioPath)
      .then(() => console.log('[clicky:whisper] temp audio file deleted', { path: audioPath }))
      .catch((err) => console.warn('[clicky:whisper] temp audio file delete failed', { path: audioPath, err }));
  }
}

async function getOpenAiApiKey(): Promise<string> {
  await loadDotEnv();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[clicky:whisper] OPENAI_API_KEY is not configured');
    throw new Error('OPENAI_API_KEY is not configured');
  }
  console.log('[clicky:whisper] OpenAI API key found', {
    source: process.env.OPENAI_API_KEY ? 'environment-or-dotenv' : 'missing'
  });
  return apiKey;
}

async function getCachedTranscribeToken(): Promise<TranscribeTokenResponse> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedTranscribeToken && cachedTranscribeToken.value.expiresAt > now + 60) {
    console.log('[clicky:transcribe] using cached realtime token', {
      expiresAt: cachedTranscribeToken.value.expiresAt,
      ageMs: Date.now() - cachedTranscribeToken.fetchedAt
    });
    return cachedTranscribeToken.value;
  }
  if (pendingTranscribeToken) {
    console.log('[clicky:transcribe] awaiting pending realtime token');
    return pendingTranscribeToken;
  }

  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  pendingTranscribeToken = api.getTranscribeToken()
    .then((token) => {
      cachedTranscribeToken = { value: token, fetchedAt: Date.now() };
      console.log('[clicky:transcribe] realtime token fetched', {
        model: token.model,
        expiresAt: token.expiresAt
      });
      return token;
    })
    .finally(() => {
      pendingTranscribeToken = undefined;
    });
  return pendingTranscribeToken;
}

async function loadDotEnv(): Promise<void> {
  if (envLoaded) return;
  envLoaded = true;

  const candidates = [
    join(process.cwd(), '.env'),
    join(app.getAppPath(), '.env'),
    join(dirname(process.execPath), '.env')
  ];

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf8');
      let loaded = 0;
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = unquoteEnvValue(match[2]);
        loaded += 1;
      }
      console.log('[clicky:env] .env loaded', { path, loaded });
      return;
    } catch {
      void 0;
    }
  }
  console.log('[clicky:env] no .env file found in configured locations');
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('wav')) return '.wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  return '.webm';
}

function splitEnvList(value: string | undefined): string[] {
  return value?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

async function ensureUniquePath(dir: string, filename: string): Promise<string> {
  let destPath = join(dir, filename);
  let counter = 1;
  const ext = extname(filename);
  const base = basename(filename, ext);
  while (true) {
    try {
      await stat(destPath);
      destPath = join(dir, `${base} (${counter})${ext}`);
      counter++;
    } catch {
      break;
    }
  }
  return destPath;
}

function registerPushToTalkShortcut(): void {
  const shortcut = process.env.CLICKY_HOTKEY ?? 'Control+Alt+Space';
  const registered = globalShortcut.register(shortcut, () => handlePushToTalkTrigger('electron-globalShortcut'));

  if (registered) {
    console.log('[clicky:hotkey] global shortcut registered', { shortcut });
  } else {
    const fallback = isWayland() && isGnomeDesktop()
      ? 'GNOME custom shortcut fallback will be attempted'
      : 'use the tray menu or set CLICKY_HOTKEY to an unused shortcut';
    console.warn('[clicky:hotkey] global shortcut unavailable', { shortcut, fallback });
  }
}

async function registerGnomeWaylandShortcut(): Promise<void> {
  if (!isWayland()) {
    console.log('[clicky:hotkey] GNOME Wayland shortcut skipped; not a Wayland session');
    return;
  }
  if (!isGnomeDesktop()) {
    console.log('[clicky:hotkey] GNOME Wayland shortcut skipped; desktop is not GNOME-compatible', {
      desktop: `${process.env.XDG_CURRENT_DESKTOP ?? ''}:${process.env.DESKTOP_SESSION ?? ''}`
    });
    return;
  }

  const binding = process.env.CLICKY_GNOME_HOTKEY ?? '<Control><Alt>space';
  const command = getToggleRecorderCommand();
  console.log('[clicky:hotkey] attempting GNOME Wayland shortcut registration', { binding, command });
  try {
    const currentRaw = await execFileOutput('gsettings', ['get', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings']);
    const paths = parseGSettingsStringList(currentRaw);
    const nextPaths = paths.includes(GNOME_CLICKY_SHORTCUT_PATH) ? paths : [...paths, GNOME_CLICKY_SHORTCUT_PATH];

    if (nextPaths.length !== paths.length) {
      await execFileOutput('gsettings', ['set', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings', formatGSettingsStringList(nextPaths)]);
    }
    await execFileOutput('gsettings', ['set', `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${GNOME_CLICKY_SHORTCUT_PATH}`, 'name', 'Clicky push to talk']);
    await execFileOutput('gsettings', ['set', `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${GNOME_CLICKY_SHORTCUT_PATH}`, 'command', command]);
    await execFileOutput('gsettings', ['set', `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${GNOME_CLICKY_SHORTCUT_PATH}`, 'binding', binding]);
    console.log('[clicky:hotkey] GNOME Wayland shortcut registered', { binding, command });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[clicky:hotkey] GNOME Wayland shortcut registration failed', { message });
  }
}

function isGnomeDesktop(): boolean {
  const desktop = `${process.env.XDG_CURRENT_DESKTOP ?? ''}:${process.env.DESKTOP_SESSION ?? ''}`.toLowerCase();
  return desktop.includes('gnome') || desktop.includes('ubuntu');
}

function summarizeEmailConfig(email: AppSettings['email']): Record<string, unknown> | undefined {
  if (!email) return undefined;
  return {
    enabled: email.enabled,
    provider: email.provider,
    username: email.username,
    hasPassword: !!email.password,
    imapHost: email.imapHost,
    imapPort: email.imapPort
  };
}

function getToggleRecorderCommand(): string {
  const executable = process.execPath;
  if (app.isPackaged) {
    return `${executable} ${TOGGLE_RECORDER_ARG}`;
  }

  const entry = process.argv.find((arg, index) => index > 0 && !arg.startsWith('-'));
  const entryPath = entry ? (isAbsolute(entry) ? entry : resolve(process.cwd(), entry)) : undefined;
  return entry
    ? `${executable} ${entryPath} ${TOGGLE_RECORDER_ARG}`
    : `${executable} ${TOGGLE_RECORDER_ARG}`;
}

async function execFileOutput(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args);
  return stdout.trim();
}

function parseGSettingsStringList(value: string): string[] {
  const paths: string[] = [];
  const re = /'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

function formatGSettingsStringList(paths: string[]): string {
  return `[${paths.map((path) => `'${path.replace(/'/g, `\\'`)}'`).join(', ')}]`;
}

async function executeShellCommand(command: string): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execAsync(command, { shell: '/bin/bash' });
    return { stdout: stdout.trim(), stderr: stderr.trim(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const stderr = (err as { stderr?: string }).stderr ?? '';
    return { stdout: stdout.trim(), stderr: stderr.trim(), error: message };
  }
}

async function writeGeneratedFile(filePath: string, content: string): Promise<string> {
  if (!isAbsolute(filePath)) {
    throw new Error('write_file requires an absolute file_path under /tmp/clicky_apps');
  }

  const resolvedPath = resolve(filePath);
  const allowedRoot = `${CLICKY_APPS_DIR}/`;
  if (resolvedPath !== CLICKY_APPS_DIR && !resolvedPath.startsWith(allowedRoot)) {
    throw new Error(`write_file can only write under ${CLICKY_APPS_DIR}`);
  }

  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, content, 'utf8');
  return resolvedPath;
}

async function processAgentStream(
  api: WorkerApi,
  request: VoiceTurnRequest,
  win: BrowserWindow,
  state: AgentState,
  agentId: string
): Promise<void> {
  console.log('[clicky:agent] stream started', {
    agentId,
    transcript: request.transcript,
    captures: request.captures.length,
    history: request.conversationHistory.length
  });
  let fullResponse = '';
  let chunkCount = 0;
  let streamedChars = 0;
  const chatChunks = createChatChunkFlusher(win);

  try {
    for await (const event of api.sendTurn(request)) {
      if (event.type === 'chunk' && event.text) {
        chunkCount++;
        streamedChars += event.text.length;
        fullResponse += event.text;
        const commandMatch = event.text.match(/(?:^|\n)(?:\$\s+)?(ls\s+|sed\s+|mkdir\s+|cd\s+|cp\s+|mv\s+|rm\s+|git\s+|npm\s+|pip\s+|python\s+|node\s+)[^\n]+/);
        if (commandMatch) {
          state.commands.push(commandMatch[0].trim());
          console.log('[clicky:agent] command detected in stream', {
            agentId,
            command: commandMatch[0].trim()
          });
          safeSend(win, ipcChannels.agentCommandFlash, commandMatch[0].trim());
        }
        chatChunks.append(event.text);
      } else if (event.type === 'tool_call' && event.name === 'execute_bash_command') {
        chatChunks.flush();
        let args: { command?: string } = {};
        try {
          args = event.arguments ? JSON.parse(event.arguments) as { command?: string } : {};
        } catch {
          args = {};
        }
        const command = args.command;
        if (command) {
          state.commands.push(command);
          console.log('[clicky:agent] executing tool command', { agentId, command });
          safeSend(win, ipcChannels.agentCommandFlash, command);

          const result = await executeShellCommand(command);
          console.log('[clicky:agent] tool command completed', {
            agentId,
            stdoutChars: result.stdout.length,
            stderrChars: result.stderr.length,
            error: result.error
          });

          const toolResultRequest: VoiceTurnRequest = {
            transcript: `Command executed. Output:\n${result.stdout}\n${result.stderr}${result.error ? `\nError: ${result.error}` : ''}`.trim(),
            captures: [],
            model: request.model,
            conversationHistory: [
              ...request.conversationHistory,
              { role: 'user', content: request.transcript },
              { role: 'assistant', content: fullResponse }
            ],
            agentId
          };

          await processAgentStream(api, toolResultRequest, win, state, agentId);
          return;
        }
      } else if (event.type === 'tool_call' && event.name === 'write_file') {
        chatChunks.flush();
        console.log('[clicky:agent] TOOL_CALL write_file RECEIVED', { agentId, argsChars: event.arguments?.length ?? 0 });
        let args: { file_path?: string; content?: string } = {};
        try {
          args = event.arguments ? JSON.parse(event.arguments) as { file_path?: string; content?: string } : {};
        } catch {
          args = {};
        }

      const filePath = args.file_path;
      const content = args.content;
      if (filePath && typeof content === 'string') {
        const feedback = `Writing ${filePath}`;
        state.commands.push(feedback);
        safeSend(win, ipcChannels.agentCommandFlash, feedback);

        let transcript: string;
        try {
          const writtenPath = await writeGeneratedFile(filePath, content);
          console.log('[clicky:agent] file written', { agentId, path: writtenPath, chars: content.length });
          transcript = `File written successfully: ${writtenPath}\nNext, launch it if this is an app, website, game, tool, or script.`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[clicky:agent] write_file failed', { agentId, filePath, error: message });
          transcript = `I was unable to write the file. Error: ${message}`;
        }

        const toolResultRequest: VoiceTurnRequest = {
          transcript,
          captures: [],
          model: request.model,
          conversationHistory: [
            ...request.conversationHistory,
            { role: 'user', content: request.transcript },
            { role: 'assistant', content: fullResponse }
          ],
          agentId
        };

        await processAgentStream(api, toolResultRequest, win, state, agentId);
        return;
      }
    } else if (event.type === 'tool_call' && event.name === 'check_email') {
      chatChunks.flush();
      console.log('[clicky:agent] TOOL_CALL check_email RECEIVED', { agentId, args: event.arguments });
      let args: { count?: number } = {};
      try {
        args = event.arguments ? JSON.parse(event.arguments) as { count?: number } : {};
      } catch {
        args = {};
      }
      const count = Math.min(Math.max(args.count ?? 5, 1), 10);
      console.log('[clicky:agent] checking emails', { agentId, count, emailSettings: summarizeEmailConfig(settings.email) });
      safeSend(win, ipcChannels.agentCommandFlash, 'Checking emails...');

      try {
        const { fetchRecentEmails } = await import('./emailService');
        const emailConfig = settings.email ?? { enabled: false, provider: 'gmail', username: '', password: '' };
        console.log('[clicky:agent] email config resolved', { enabled: emailConfig.enabled, username: emailConfig.username, hasPassword: !!emailConfig.password });
        const emails = await fetchRecentEmails(emailConfig, count);
        state.emails = emails;
        const emailSummary = emails.length === 0
          ? 'No emails found in your inbox.'
          : emails.map((e, i) => {
              let text = `Email #${i + 1}\nFrom: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nPreview: ${e.preview}`;
              if (e.attachments.length > 0) {
                text += `\nAttachments: ${e.attachments.join(', ')}`;
              }
              return text;
            }).join('\n\n');

        const toolResultRequest: VoiceTurnRequest = {
          transcript: `Here are the recent emails:\n${emailSummary}`,
          captures: [],
          model: request.model,
          conversationHistory: [
            ...request.conversationHistory,
            { role: 'user', content: request.transcript },
            { role: 'assistant', content: fullResponse }
          ],
          agentId
        };

        await processAgentStream(api, toolResultRequest, win, state, agentId);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[clicky:agent] email check failed', { agentId, error: message });
        const toolResultRequest: VoiceTurnRequest = {
          transcript: `I was unable to check your emails. Error: ${message}`,
          captures: [],
          model: request.model,
          conversationHistory: [
            ...request.conversationHistory,
            { role: 'user', content: request.transcript },
            { role: 'assistant', content: fullResponse }
          ],
          agentId
        };
        await processAgentStream(api, toolResultRequest, win, state, agentId);
        return;
      }
    } else if (event.type === 'tool_call' && event.name === 'open_url') {
      chatChunks.flush();
      console.log('[clicky:agent] TOOL_CALL open_url RECEIVED', { agentId, args: event.arguments });
      let args: { url?: string } = {};
      try {
        args = event.arguments ? JSON.parse(event.arguments) as { url?: string } : {};
      } catch {
        args = {};
      }
      const url = args.url;
      if (url) {
        safeSend(win, ipcChannels.agentCommandFlash, `Opening ${url} in browser...`);
        try {
          await shell.openExternal(url);
          console.log('[clicky:agent] URL opened successfully', { agentId, url });
          const toolResultRequest: VoiceTurnRequest = {
            transcript: `The link has been opened in the user's default browser.`,
            captures: [],
            model: request.model,
            conversationHistory: [
              ...request.conversationHistory,
              { role: 'user', content: request.transcript },
              { role: 'assistant', content: fullResponse }
            ],
            agentId
          };
          await processAgentStream(api, toolResultRequest, win, state, agentId);
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[clicky:agent] open_url failed', { agentId, url, error: message });
          const toolResultRequest: VoiceTurnRequest = {
            transcript: `I was unable to open the link. Error: ${message}`,
            captures: [],
            model: request.model,
            conversationHistory: [
              ...request.conversationHistory,
              { role: 'user', content: request.transcript },
              { role: 'assistant', content: fullResponse }
            ],
            agentId
          };
          await processAgentStream(api, toolResultRequest, win, state, agentId);
          return;
        }
      }
    } else if (event.type === 'tool_call' && event.name === 'scrape_website') {
      chatChunks.flush();
      console.log('[clicky:agent] TOOL_CALL scrape_website RECEIVED', { agentId, args: event.arguments });
      let args: { url?: string; extractMode?: string; maxChars?: number } = {};
      try {
        args = event.arguments ? JSON.parse(event.arguments) as { url?: string; extractMode?: string; maxChars?: number } : {};
      } catch {
        args = {};
      }
      const url = args.url;
      if (url) {
        safeSend(win, ipcChannels.agentCommandFlash, `Scraping ${url}...`);
        try {
          const result = await scrapeWebsite({
            url,
            extractMode: args.extractMode === 'text' ? 'text' : 'markdown',
            maxChars: args.maxChars,
          });
          console.log('[clicky:agent] website scraped successfully', { agentId, url, extractor: result.extractor });
          const prefix = result.title ? `# ${result.title}\n\n` : '';
          const toolResultRequest: VoiceTurnRequest = {
            transcript: `Here is the content from ${url}:\n\n${prefix}${result.text}`,
            captures: [],
            model: request.model,
            conversationHistory: [
              ...request.conversationHistory,
              { role: 'user', content: request.transcript },
              { role: 'assistant', content: fullResponse }
            ],
            agentId
          };
          await processAgentStream(api, toolResultRequest, win, state, agentId);
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[clicky:agent] scrape_website failed', { agentId, url, error: message });
          const toolResultRequest: VoiceTurnRequest = {
            transcript: `I was unable to scrape the website. Error: ${message}`,
            captures: [],
            model: request.model,
            conversationHistory: [
              ...request.conversationHistory,
              { role: 'user', content: request.transcript },
              { role: 'assistant', content: fullResponse }
            ],
            agentId
          };
          await processAgentStream(api, toolResultRequest, win, state, agentId);
          return;
        }
      }
    } else if (event.type === 'tool_call' && event.name === 'download_email_attachment') {
      chatChunks.flush();
      console.log('[clicky:agent] TOOL_CALL download_email_attachment RECEIVED', { agentId, args: event.arguments });
      let args: { email_number?: number; filename?: string } = {};
      try {
        args = event.arguments ? JSON.parse(event.arguments) as { email_number?: number; filename?: string } : {};
      } catch {
        args = {};
      }
      const emailNumber = args.email_number;
      const filename = args.filename;
      const emails = state.emails ?? [];
      const email = emailNumber && emailNumber > 0 && emailNumber <= emails.length ? emails[emailNumber - 1] : undefined;

      if (!email || !filename) {
        const toolResultRequest: VoiceTurnRequest = {
          transcript: 'I could not find the email or attachment you asked for. Please specify the email number and filename clearly.',
          captures: [],
          model: request.model,
          conversationHistory: [
            ...request.conversationHistory,
            { role: 'user', content: request.transcript },
            { role: 'assistant', content: fullResponse }
          ],
          agentId
        };
        await processAgentStream(api, toolResultRequest, win, state, agentId);
        return;
      }

      safeSend(win, ipcChannels.agentCommandFlash, `Downloading ${filename}...`);
      try {
        const emailConfig = settings.email ?? { enabled: false, provider: 'gmail', username: '', password: '' };
        const { downloadAttachment } = await import('./emailService');
        const destPath = await ensureUniquePath(app.getPath('downloads'), filename);
        await downloadAttachment(emailConfig, email.uid, filename, destPath);
        console.log('[clicky:agent] attachment downloaded', { agentId, uid: email.uid, filename, destPath });
        const toolResultRequest: VoiceTurnRequest = {
          transcript: `The attachment "${filename}" has been downloaded to ${destPath}.`,
          captures: [],
          model: request.model,
          conversationHistory: [
            ...request.conversationHistory,
            { role: 'user', content: request.transcript },
            { role: 'assistant', content: fullResponse }
          ],
          agentId
        };
        await processAgentStream(api, toolResultRequest, win, state, agentId);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[clicky:agent] download_email_attachment failed', { agentId, uid: email.uid, filename, error: message });
        const toolResultRequest: VoiceTurnRequest = {
          transcript: `I was unable to download the attachment "${filename}". Error: ${message}`,
          captures: [],
          model: request.model,
          conversationHistory: [
            ...request.conversationHistory,
            { role: 'user', content: request.transcript },
            { role: 'assistant', content: fullResponse }
          ],
          agentId
        };
        await processAgentStream(api, toolResultRequest, win, state, agentId);
        return;
      }
    } else if (event.type === 'done') {
      chatChunks.flush();
      state.status = 'done';
      state.response = fullResponse;
      state.summary = fullResponse.slice(0, 200) + (fullResponse.length > 200 ? '...' : '');
      state.completedAt = Date.now();
      state.actions = buildDefaultActions(request.transcript, state.commands, state.emails);
      state.conversationHistory = [
        ...request.conversationHistory,
        { role: 'user', content: request.transcript },
        { role: 'assistant', content: fullResponse }
      ];
      console.log('[clicky:agent] stream done', {
        agentId,
        responseChars: fullResponse.length,
        chunks: chunkCount,
        streamedChars,
        commands: state.commands.length,
        actions: state.actions.map((action) => action.label)
      });
      safeSend(win, ipcChannels.chatDone);
      safeSend(win, ipcChannels.agentUpdate, state);
      if (fullResponse) {
        speakWithOpenAiInBackground(api, win, agentId, fullResponse, 'response');
      }
    } else if (event.type === 'error' && event.error) {
      chatChunks.flush();
      state.status = 'error';
      state.error = event.error;
      console.error('[clicky:agent] stream error', { agentId, error: event.error });
      safeSend(win, ipcChannels.chatError, event.error);
      safeSend(win, ipcChannels.agentUpdate, state);
    }
  }
  } finally {
    chatChunks.dispose();
  }
}

ipcMain.handle(ipcChannels.settingsGet, () => settings);
ipcMain.on(ipcChannels.recordingStopped, (event) => {
  if (event.sender.id !== recorderWindow?.webContents.id) return;
  stopCursorTracking('recording-stopped');
});

ipcMain.handle(ipcChannels.settingsSet, async (_event, next: AppSettings) => {
  settings = await saveSettings(next);
  return settings;
});

ipcMain.handle(ipcChannels.captureSelectScreen, async (): Promise<CaptureSource[]> => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 360, height: 220 } });
  return sources.map((source) => ({
    id: source.id,
    label: source.name,
    thumbnailDataUrl: source.thumbnail.toDataURL()
  }));
});

ipcMain.handle(ipcChannels.captureSetSelectedScreen, async (_event, source: CaptureSource) => {
  settings = await saveSettings({
    ...settings,
    selectedCaptureSourceId: source.id,
    selectedCaptureSourceLabel: source.label
  });
  return settings;
});

function isWayland(): boolean {
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
}

async function tryGrimScreenshot(): Promise<ScreenCapturePayload | null> {
  if (!isWayland()) return null;
  try {
    const tmpPath = join(tmpdir(), `clicky-screenshot-${randomUUID()}.jpg`);
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    await execAsync(`grim -t jpeg -q 82 "${tmpPath}"`, { timeout: 10000 });
    const jpegBuffer = await readFile(tmpPath);
    await unlink(tmpPath).catch(() => {});
    return {
      jpegBase64: jpegBuffer.toString('base64'),
      label: 'Linux screen (grim)',
      width,
      height
    };
  } catch {
    return null;
  }
}

async function tryFfmpegScreenshot(): Promise<ScreenCapturePayload | null> {
  if (isWayland()) return null;
  try {
    const tmpPath = join(tmpdir(), `clicky-screenshot-${randomUUID()}.jpg`);
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    await execAsync(`ffmpeg -f x11grab -video_size ${width}x${height} -i :0.0 -vframes 1 -q:v 5 -y "${tmpPath}"`, { timeout: 10000 });
    const jpegBuffer = await readFile(tmpPath);
    await unlink(tmpPath).catch(() => {});
    return {
      jpegBase64: jpegBuffer.toString('base64'),
      label: 'Linux screen (ffmpeg)',
      width,
      height
    };
  } catch {
    return null;
  }
}

ipcMain.handle(ipcChannels.captureTakeScreenshot, async (): Promise<ScreenCapturePayload> => {
  if (isWayland()) {
    const grimResult = await tryGrimScreenshot();
    if (grimResult) {
      console.log('[clicky:capture] screenshot taken via grim');
      return grimResult;
    }
    console.log('[clicky:capture] grim failed, falling back to desktopCapturer');
  } else {
    const ffmpegResult = await tryFfmpegScreenshot();
    if (ffmpegResult) {
      console.log('[clicky:capture] screenshot taken via ffmpeg');
      return ffmpegResult;
    }
    console.log('[clicky:capture] ffmpeg failed, falling back to desktopCapturer');
  }

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 1280 } });
  const cursor = screen.getCursorScreenPoint();
  const currentDisplay = screen.getDisplayNearestPoint(cursor);

  let source = sources.find((s) => s.id === settings.selectedCaptureSourceId);
  if (!source) {
    source = sources.find((s) => s.name.includes(currentDisplay.id.toString()) || s.name.includes(currentDisplay.label ?? ''));
  }
  if (!source) {
    source = sources[0];
  }

  if (!source) {
    throw new Error('No screen source available for screenshot');
  }

  const thumbnail = source.thumbnail;
  const size = thumbnail.getSize();
  const jpegBuffer = thumbnail.toJPEG(82);

  return {
    jpegBase64: jpegBuffer.toString('base64'),
    label: source.name,
    width: size.width,
    height: size.height
  };
});

ipcMain.handle(ipcChannels.chatSendTurn, async (_event, request: VoiceTurnRequest) => {
  console.log('[clicky:ipc] chatSendTurn invoked', {
    agentId: request.agentId,
    transcript: request.transcript,
    captures: request.captures.length
  });
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  const targetWindow = request.agentId ? agents.get(request.agentId)?.window : undefined;
  try {
    for await (const event of api.sendTurn(request)) {
      safeSend(targetWindow, `chat:${event.type}`, event.text ?? event.error ?? '');
    }
  } catch (error) {
    console.error('[clicky:ipc] chatSendTurn failed', { agentId: request.agentId, error });
    safeSend(targetWindow, ipcChannels.chatError, error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle(ipcChannels.audioTranscribe, async (_event, audio: RecordedAudioPayload): Promise<string> => {
  console.log('[clicky:ipc] audioTranscribe invoked', {
    bytes: audio.bytes.byteLength,
    mimeType: audio.mimeType
  });
  return transcribeWithWhisper(audio);
});

ipcMain.handle(ipcChannels.transcribeGetToken, async () => {
  return getCachedTranscribeToken();
});

ipcMain.handle(ipcChannels.realtimeCreateCall, async (_event, offerSdp: string) => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  return api.createRealtimeTranscriptionCall(offerSdp);
});

ipcMain.handle(ipcChannels.ttsSpeak, async (_event, text: string, agentId?: string) => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  const targetWindow = agentId ? agents.get(agentId)?.window : undefined;
  try {
    const audio = await api.synthesizeSpeech(text);
    safeSend(targetWindow, ipcChannels.ttsAudio, audio);
  } catch (error) {
    safeSend(targetWindow, ipcChannels.ttsError, error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle(ipcChannels.agentSpawn, async (_event, request: VoiceTurnRequest): Promise<string> => {
  const agentId = randomUUID();
  console.log('[clicky:agent] spawn requested', {
    agentId,
    transcript: request.transcript,
    captures: request.captures.length,
    model: request.model
  });
  const win = createAgentWindow(agentId);
  const color = assignedAgentColors.get(agentId);

  const state: AgentState = {
    id: agentId,
    status: 'running',
    transcript: request.transcript,
    response: '',
    summary: '',
    commands: [],
    actions: [],
    model: request.model,
    conversationHistory: request.conversationHistory,
    captures: request.captures,
    createdAt: Date.now(),
    color
  };

  agents.set(agentId, { window: win, state, expanded: false });
  console.log('[clicky:agent] state stored', { agentId });

  win.webContents.on('did-finish-load', () => {
    console.log('[clicky:agent] renderer loaded; sending initial state', { agentId });
    safeSend(win, ipcChannels.agentUpdate, state);
  });

  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  try {
    await waitForWindowLoad(win);
    speakTaskAcknowledgement(api, win, agentId, request.transcript);
    await processAgentStream(api, { ...request, agentId }, win, state, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[clicky:agent] processAgentStream threw', { agentId, error: message });
    state.status = 'error';
    state.error = message;
    safeSend(win, ipcChannels.chatError, message);
    safeSend(win, ipcChannels.agentUpdate, state);
  }

  return agentId;
});

ipcMain.handle(ipcChannels.agentSpawnError, (_event, message: string): string => {
  console.log('[clicky:agent] spawn error requested', { message });
  return createErrorAgent(message);
});

ipcMain.handle(ipcChannels.agentClose, (_event, agentId: string) => {
  const entry = agents.get(agentId);
  if (entry) {
    entry.window.close();
  }
});

ipcMain.handle(ipcChannels.agentRunAction, async (_event, action: AgentAction) => {
  if (action.type === 'open_folder' && action.payload) {
    const result = await shell.openPath(action.payload);
    if (result) {
      throw new Error(result);
    }
  } else if (action.type === 'open_app' && action.payload) {
    await shell.openExternal(`x-scheme-handler/${action.payload}`).catch(async () => {
      await execAsync(`xdg-open ${JSON.stringify(action.payload)}`);
    });
  } else if (action.type === 'open_url' && action.payload) {
    await shell.openExternal(action.payload);
  } else if (action.type === 'custom' && action.payload) {
    const payload = JSON.parse(action.payload) as { type: string; uid: number; filename: string };
    if (payload.type === 'download_email_attachment') {
      const emailConfig = settings.email ?? { enabled: false, provider: 'gmail', username: '', password: '' };
      if (!emailConfig.enabled) {
        throw new Error('Email not configured.');
      }
      const { downloadAttachment } = await import('./emailService');
      const destPath = await ensureUniquePath(app.getPath('downloads'), payload.filename);
      await downloadAttachment(emailConfig, payload.uid, payload.filename, destPath);
      await shell.openPath(dirname(destPath));
    }
  }
});

ipcMain.handle(ipcChannels.agentSetExpanded, (_event, agentId: string, expanded: boolean) => {
  setAgentWindowExpanded(agentId, expanded);
});

ipcMain.handle(ipcChannels.openUrl, async (_event, url: string) => {
  console.log('[clicky:main] openUrl invoked', { url });
  await shell.openExternal(url);
});

ipcMain.handle(ipcChannels.scrapeWebsite, async (_event, url: string): Promise<string> => {
  console.log('[clicky:main] scrapeWebsite invoked', { url });
  const result = await scrapeWebsite({ url });
  const prefix = result.title ? `# ${result.title}\n\n` : '';
  return `${prefix}${result.text}`;
});

ipcMain.handle(ipcChannels.windowGetContext, (event): WindowContext | undefined => {
  return windowContexts.get(event.sender.id);
});

ipcMain.handle(ipcChannels.executeShell, async (_event, command: string): Promise<ShellResult> => {
  try {
    const { stdout, stderr } = await execAsync(command, { shell: '/bin/bash' });
    return { stdout: stdout.trim(), stderr: stderr.trim(), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const stderr = (err as { stderr?: string }).stderr ?? '';
    return { stdout: stdout.trim(), stderr: stderr.trim(), error: message };
  }
});

ipcMain.handle(ipcChannels.agentFollowUp, async (_event, agentId: string, request: VoiceTurnRequest) => {
  console.log('[clicky:agent] follow-up requested', {
    agentId,
    transcript: request.transcript,
    captures: request.captures.length,
    history: request.conversationHistory.length
  });
  const entry = agents.get(agentId);
  if (!entry) {
    console.warn('[clicky:agent] follow-up ignored; agent not found', { agentId });
    return;
  }
  const { window: win, state } = entry;

  state.status = 'running';
  state.transcript = request.transcript;
  state.response = '';
  state.summary = '';
  state.commands = [];
  state.error = undefined;
  state.completedAt = undefined;
  state.conversationHistory = request.conversationHistory;
  safeSend(win, ipcChannels.agentUpdate, state);

  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  try {
    speakTaskAcknowledgement(api, win, agentId, request.transcript);
    await processAgentStream(api, { ...request, agentId }, win, state, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[clicky:agent] follow-up stream threw', { agentId, error: message });
    state.status = 'error';
    state.error = message;
    safeSend(win, ipcChannels.chatError, message);
    safeSend(win, ipcChannels.agentUpdate, state);
  }
});

if (hasSingleInstanceLock) {
  app.whenReady().then(initApp);
}
app.on('will-quit', () => {
  stopCursorTracking('app-quit');
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
  globalShortcut.unregisterAll();
  console.log('[clicky:hotkey] global shortcuts unregistered');
});
app.on('window-all-closed', () => {
  void 0;
});
