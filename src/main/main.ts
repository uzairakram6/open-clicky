import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron';
import { appendFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSettings, saveSettings } from './settings';
import { buildOpenAIMessages, WorkerApi } from './workerApi';
import { scrapeWebsite } from './scraper';
import { ipcChannels } from '../shared/ipcChannels';
import { buildTaskAcknowledgement, cleanAcknowledgementSpeech } from '../shared/acknowledgement';
import type { AppSettings, CaptureSource, VoiceTurnRequest, AgentState, WindowContext, AgentAction, ScreenCapturePayload, ShellResult, RecordedAudioPayload, TranscribeTokenResponse, RealtimeToolRequest, RealtimeToolResponse } from '../shared/types';
import { splitAgentReply } from '../shared/splitAgentReply';
import { buildRecentEmailDisplaySummary } from '../shared/emailDisplay';
import { compactDisplaySummary } from '../shared/displaySummary';
import { isE2EMode, createFakeWorkerApi } from '../test-helpers/e2e-mode';
import { FakeWorkerApi } from '../test-helpers/e2e-fake-api';

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
const ttsSequenceByAgent = new Map<string, number>();
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
let fakeWorkerApi: FakeWorkerApi | undefined;
const assignedAgentColors = new Map<string, string>();
const CHAT_CHUNK_FLUSH_MS = 50;
const CHAT_CHUNK_MAX_CHARS = 160;
const LOCAL_SPEECH_MAX_CHARS = 1200;

function safeSend(win: BrowserWindow | undefined, channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

type AgentRunLogEvent = {
  at: string;
  type: string;
  agentId: string;
  details?: unknown;
};

function agentRunDir(): string {
  return join(app.getPath('userData'), 'agent-runs');
}

function sanitizeAgentStateForLog(state: AgentState): AgentState {
  return {
    ...state,
    captures: state.captures.map((capture) => ({
      ...capture,
      jpegBase64: `[redacted:${capture.jpegBase64.length} chars]`
    }))
  };
}

function trimLogText(value: string, max = 12000): string {
  return value.length > max ? `${value.slice(0, max)}...[truncated ${value.length - max} chars]` : value;
}

function logAgentRunEvent(agentId: string, type: string, details?: unknown): void {
  void (async () => {
    try {
      const dir = agentRunDir();
      await mkdir(dir, { recursive: true });
      const event: AgentRunLogEvent = { at: new Date().toISOString(), type, agentId, details };
      await appendFile(join(dir, `${agentId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
      console.warn('[clicky:agent-log] write failed', {
        agentId,
        type,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
}

function persistAgentStateSnapshot(state: AgentState, reason: string): void {
  const sanitized = sanitizeAgentStateForLog(state);
  logAgentRunEvent(state.id, 'state_snapshot', { reason, state: sanitized });
  void (async () => {
    try {
      const dir = agentRunDir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${state.id}.latest.json`), JSON.stringify({ reason, state: sanitized }, null, 2), 'utf8');
    } catch (error) {
      console.warn('[clicky:agent-log] snapshot write failed', {
        agentId: state.id,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();
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
    const sequence = (ttsSequenceByAgent.get(agentId) ?? 0) + 1;
    ttsSequenceByAgent.set(agentId, sequence);
    logAgentRunEvent(agentId, 'tts_request', { reason, text: trimLogText(speechText), chars: speechText.length });

    try {
      console.log('[clicky:agent] requesting OpenAI speech', { agentId, reason, chars: speechText.length });
      const audio = await api.synthesizeSpeech(speechText);
      if (ttsSequenceByAgent.get(agentId) !== sequence) {
        console.log('[clicky:agent] skipped stale speech audio', { agentId, reason, sequence });
        logAgentRunEvent(agentId, 'tts_skipped_stale', { reason, sequence });
        return;
      }
      if (reason === 'acknowledgement' && agents.get(agentId)?.state.status !== 'running') {
        console.log('[clicky:agent] skipped stale acknowledgement speech', { agentId });
        logAgentRunEvent(agentId, 'tts_skipped_stale_acknowledgement');
        return;
      }
      safeSend(win, ipcChannels.ttsAudio, audio);
      console.log('[clicky:agent] OpenAI speech audio sent', { agentId, reason, bytes: audio.byteLength });
      logAgentRunEvent(agentId, 'tts_audio_sent', { reason, bytes: audio.byteLength });
    } catch (error) {
      console.warn('[clicky:agent] OpenAI speech failed; falling back to local speech', {
        agentId,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
      logAgentRunEvent(agentId, 'tts_error', { reason, error: error instanceof Error ? error.message : String(error) });
      try {
        await speakTextLocally(win, speechText);
      } catch {
        void 0;
      }
    }
  })();
}

function stopAgentSpeech(win: BrowserWindow, agentId: string, reason: string): void {
  const sequence = (ttsSequenceByAgent.get(agentId) ?? 0) + 1;
  ttsSequenceByAgent.set(agentId, sequence);
  logAgentRunEvent(agentId, 'tts_stop', { reason, sequence });
  safeSend(win, ipcChannels.ttsStop);
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

let lastRendererCursorPos: { x: number; y: number } | undefined;

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

const hasSingleInstanceLock = isE2EMode() ? true : app.requestSingleInstanceLock();
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
  if (!isE2EMode()) {
    createTray();
    registerPushToTalkShortcut();
  }

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
    width: isE2EMode() ? 400 : 1,
    height: isE2EMode() ? 300 : 1,
    show: isE2EMode(),
    skipTaskbar: true,
    focusable: !isE2EMode(),
    webPreferences: {
      preload: isE2EMode() ? join(__dirname, '../preload/preload.cjs') : undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  keepAliveWindow.on('closed', () => {
    keepAliveWindow = undefined;
  });

  if (isE2EMode()) {
    const rendererHtml = join(__dirname, '../renderer/index.html');
    void keepAliveWindow.loadFile(rendererHtml);
  }
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

function createRealtimeAgent(request: VoiceTurnRequest): string {
  const agentId = randomUUID();
  const win = createAgentWindow(agentId);
  const color = assignedAgentColors.get(agentId);
  const state: AgentState = {
    id: agentId,
    status: 'running',
    transcript: request.transcript,
    response: '',
    displayCaption: '',
    displayHeader: 'Thinking',
    displayDetails: undefined,
    summary: 'Processing...',
    commands: [],
    actions: [],
    model: 'gpt-realtime-2',
    conversationHistory: request.conversationHistory,
    captures: request.captures,
    createdAt: Date.now(),
    color
  };

  agents.set(agentId, { window: win, state, expanded: false });
  logAgentRunEvent(agentId, 'agent_spawn_realtime', {
    transcript: request.transcript,
    captures: request.captures.map(({ label, width, height }) => ({ label, width, height })),
    model: state.model
  });
  persistAgentStateSnapshot(state, 'spawn-realtime');
  const sendInitialState = (reason: string) => {
    console.log('[clicky:agent] sending realtime initial state', { agentId, reason });
    safeSend(win, ipcChannels.agentUpdate, state);
  };
  win.webContents.on('did-finish-load', () => sendInitialState('did-finish-load'));
  win.once('ready-to-show', () => sendInitialState('ready-to-show'));
  setTimeout(() => sendInitialState('delayed-250ms'), 250);
  setTimeout(() => sendInitialState('delayed-1000ms'), 1000);
  return agentId;
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
    displayCaption: '',
    displayHeader: '',
    displayDetails: undefined,
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
  logAgentRunEvent(agentId, 'agent_spawn_error', { message });
  persistAgentStateSnapshot(state, 'spawn-error');
  win.webContents.on('did-finish-load', () => {
    console.log('[clicky:agent] sending error state to renderer', { agentId });
    safeSend(win, ipcChannels.agentUpdate, state);
    safeSend(win, ipcChannels.chatError, message);
  });
  return agentId;
}

function createAgentWorkerApi(): WorkerApi {
  const realApi = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  if (isE2EMode() && process.env.CLICKY_REAL_E2E !== '1' && fakeWorkerApi) {
    return fakeWorkerApi as unknown as WorkerApi;
  }
  return realApi;
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
    form.append('language', 'en');
    form.append(
      'prompt',
      'Transcribe in English only. Do not translate into Urdu or output non-English script. If speech is unclear, choose the closest English words.'
    );

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

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function transcriptRequestsOpenAction(transcript: string): boolean {
  const text = transcript.toLowerCase();
  return /\b(open|launch|view)\b/.test(text);
}

function transcriptRequestsBuildAction(transcript: string): boolean {
  const text = transcript.toLowerCase();
  const buildVerb = /\b(build|make|create|generate|code|turn|convert|transform)\b/.test(text);
  const target = /\b(site|website|web\s?page|landing\s?page|app|page)\b/.test(text);
  const intoWebsite = /\b(?:turn|convert|transform)\b[\s\S]{0,80}\b(?:into|to)\b[\s\S]{0,80}\b(?:a\s+)?(?:site|website|web\s?page|landing\s?page|app|page)\b/.test(text);
  return (buildVerb && target) || intoWebsite;
}

function inferOpenLastDownloadedCommand(transcript: string, lastDownloadedPath: string | undefined): string | undefined {
  if (!lastDownloadedPath) return undefined;
  if (!transcriptRequestsOpenAction(transcript)) return undefined;
  return `xdg-open ${shellSingleQuote(lastDownloadedPath)}`;
}

function buildOpenFileCommand(filePath: string): string {
  return `xdg-open ${shellSingleQuote(filePath)} >/dev/null 2>&1 &`;
}

function inferOpenGeneratedAppCommand(transcript: string, generatedAppPath: string | undefined): string | undefined {
  if (!generatedAppPath) return undefined;
  if (!transcriptRequestsOpenAction(transcript) && !transcriptRequestsBuildAction(transcript)) return undefined;
  const fileUrl = pathToFileURL(generatedAppPath).toString();
  return `if command -v google-chrome >/dev/null 2>&1; then google-chrome --new-tab ${shellSingleQuote(fileUrl)} >/dev/null 2>&1 & elif command -v google-chrome-stable >/dev/null 2>&1; then google-chrome-stable --new-tab ${shellSingleQuote(fileUrl)} >/dev/null 2>&1 & elif command -v chromium >/dev/null 2>&1; then chromium --new-tab ${shellSingleQuote(fileUrl)} >/dev/null 2>&1 & else xdg-open ${shellSingleQuote(fileUrl)} >/dev/null 2>&1 & fi`;
}

function isOpenLikeShellCommand(command: string): boolean {
  return /\b(xdg-open|google-chrome|google-chrome-stable|chromium)\b/.test(command);
}

function transcriptRequestsDesktopCleanup(transcript: string): boolean {
  return /\b(desktop|home screen|docx|xlsx|pdf|document|spreadsheet|excel|word|clean|cleanup|declutter|tidy|remove|get rid|delete|move|trash)\b/i.test(transcript)
    && /\b(file|files|docx|xlsx|pdf|document|spreadsheet|excel|word|desktop|home screen)\b/i.test(transcript);
}

function buildDesktopCleanupCommand(): string {
  return [
    'set -e',
    'target="$HOME/Desktop"',
    'if [ ! -d "$target" ]; then',
    '  target="$HOME"',
    'fi',
    'matches=( -iname "*.doc" -o -iname "*.docx" -o -iname "*.xls" -o -iname "*.xlsx" -o -iname "*.pdf" )',
    'before=$(find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) | wc -l)',
    'if command -v gio >/dev/null 2>&1; then',
    '  find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) -print0 | xargs -0 -r gio trash',
    'else',
    '  trash="$HOME/.local/share/Trash/files"',
    '  mkdir -p "$trash"',
    '  while IFS= read -r -d "" f; do',
    '    mv -n "$f" "$trash/"',
    '  done < <(find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) -print0)',
    'fi',
    'after=$(find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) | wc -l)',
    'echo "Target: $target"',
    'echo "Matching files before: $before"',
    'echo "Matching files remaining: $after"',
    'echo "Moved to trash: $((before - after))"'
  ].join('\n');
}

function isTerminalLocalActionCommand(command: string): boolean {
  return isOpenLikeShellCommand(command) ||
    /\b(gio\s+trash|trash-put|mv|cp|mkdir|touch|chmod|chown|rm|rmdir|ln)\b/i.test(command);
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatTerminalLocalActionCompletion(command: string, result: ShellResult): string {
  if (isOpenLikeShellCommand(command) && !result.stdout.trim() && !result.stderr.trim()) {
    return 'Opened it.';
  }

  const stdoutLines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stderrLines = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastUsefulLine = stdoutLines.at(-1) ?? stderrLines.at(-1);
  if (lastUsefulLine) {
    return `Done. ${ensureSentence(lastUsefulLine.slice(0, 160))}`;
  }

  return 'Done.';
}

function extractAbsolutePathFromText(text: string): string | undefined {
  const match = text.match(/\/[^\s"'`]+/);
  return match?.[0]?.replace(/[.,;:!?]+$/, '');
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

function docxXmlToText(xml: string): string {
  return decodeXmlEntities(xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

async function readDownloadedDocumentText(filePath: string): Promise<string> {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.txt' || extension === '.md' || extension === '.csv' || extension === '.html') {
    return readFile(filePath, 'utf8');
  }
  if (extension === '.docx') {
    const { stdout } = await execFileAsync('unzip', ['-p', filePath, 'word/document.xml'], { maxBuffer: 10 * 1024 * 1024 });
    return docxXmlToText(stdout);
  }
  throw new Error(`Reading ${extension || 'this file type'} is not supported yet.`);
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugFromText(value: string, fallback: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
  return slug || fallback;
}

function buildFallbackWebsiteHtml(sourceText: string, transcript: string): string {
  const normalized = sourceText.replace(/\s+/g, ' ').trim();
  const lower = `${normalized} ${transcript}`.toLowerCase();
  const title = lower.includes('coffee') ? 'Coffee Shop Landing Page' : 'Generated Landing Page';
  const subtitle = normalized
    ? normalized.slice(0, 220)
    : 'A focused, polished landing page generated from your request.';
  const featureSource = normalized
    ? normalized.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3)
    : ['Fast-loading single page design', 'Responsive layout for mobile and desktop', 'Clear call to action'];
  const features = featureSource.length >= 3 ? featureSource : [...featureSource, 'Responsive layout', 'Clear call to action'].slice(0, 3);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(title)}</title>
  <style>
    :root { color-scheme: light; --ink: #231a12; --cream: #fff7e8; --coffee: #6f432a; --accent: #d98c38; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Georgia, 'Times New Roman', serif; color: var(--ink); background: radial-gradient(circle at top left, #ffe0a8, transparent 32rem), var(--cream); }
    main { min-height: 100vh; display: grid; place-items: center; padding: 48px 20px; }
    .card { width: min(1080px, 100%); border: 1px solid rgba(111,67,42,.25); border-radius: 34px; overflow: hidden; background: rgba(255,255,255,.72); box-shadow: 0 24px 80px rgba(74, 44, 24, .18); }
    .hero { display: grid; grid-template-columns: 1.1fr .9fr; gap: 28px; padding: clamp(32px, 6vw, 76px); align-items: center; }
    .eyebrow { letter-spacing: .18em; text-transform: uppercase; color: var(--accent); font: 700 12px ui-sans-serif, system-ui; }
    h1 { font-size: clamp(44px, 8vw, 92px); line-height: .9; margin: 12px 0 22px; }
    p { font-size: clamp(18px, 2vw, 23px); line-height: 1.55; margin: 0 0 28px; }
    .cta { display: inline-flex; align-items: center; padding: 15px 22px; border-radius: 999px; background: var(--coffee); color: white; text-decoration: none; font: 800 15px ui-sans-serif, system-ui; }
    .visual { min-height: 420px; border-radius: 28px; background: linear-gradient(145deg, #8a5130, #2c170d); position: relative; overflow: hidden; }
    .visual:before { content: ""; position: absolute; width: 220px; height: 220px; border-radius: 50%; background: #f5c16f; left: 50%; top: 20%; transform: translateX(-50%); box-shadow: 0 80px 0 16px rgba(255,255,255,.16); }
    .visual:after { content: "Fresh Daily"; position: absolute; left: 28px; bottom: 28px; color: white; font-size: 46px; font-weight: 800; }
    .features { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid rgba(111,67,42,.18); }
    .feature { padding: 28px; font: 600 16px ui-sans-serif, system-ui; }
    @media (max-width: 760px) { .hero, .features { grid-template-columns: 1fr; } .visual { min-height: 280px; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <div class="hero">
        <div>
          <div class="eyebrow">Built by Clicky</div>
          <h1>${htmlEscape(title)}</h1>
          <p>${htmlEscape(subtitle)}</p>
          <a class="cta" href="#menu">Explore the concept</a>
        </div>
        <div class="visual" aria-label="Warm coffee shop hero artwork"></div>
      </div>
      <div id="menu" class="features">
        ${features.map((feature) => `<div class="feature">${htmlEscape(feature)}</div>`).join('\n        ')}
      </div>
    </section>
  </main>
</body>
</html>
`;
}

async function buildFallbackGeneratedSite(state: AgentState, transcript: string): Promise<{ filePath: string; content: string; sourceText: string }> {
  let sourceText = '';
  if (state.lastDownloadedPath) {
    sourceText = await readDownloadedDocumentText(state.lastDownloadedPath).catch(() => '');
  }
  const slug = slugFromText(sourceText || transcript, 'generated-site');
  const filePath = join(CLICKY_APPS_DIR, slug, 'index.html');
  return {
    filePath,
    content: buildFallbackWebsiteHtml(sourceText, transcript),
    sourceText
  };
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes('wav')) return '.wav';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  return '.webm';
}

async function executeRealtimeToolRequest(request: RealtimeToolRequest): Promise<RealtimeToolResponse> {
  let args: Record<string, unknown> = {};
  try {
    args = request.arguments ? JSON.parse(request.arguments) as Record<string, unknown> : {};
  } catch {
    args = {};
  }
  const agentEntry = request.agentId ? agents.get(request.agentId) : undefined;
  const agentId = request.agentId ?? 'unknown-agent';
  logAgentRunEvent(agentId, 'realtime_tool_call', {
    name: request.name,
    arguments: trimLogText(request.arguments || '{}')
  });
  const flash = (label: string) => {
    if (agentEntry) {
      agentEntry.state.commands.push(label);
      logAgentRunEvent(agentEntry.state.id, 'command_flash', { label });
      persistAgentStateSnapshot(agentEntry.state, 'realtime-command-flash');
      safeSend(agentEntry.window, ipcChannels.agentCommandFlash, label);
      safeSend(agentEntry.window, ipcChannels.agentUpdate, agentEntry.state);
    }
  };
  const shellProgressLabel = (command: string): string => {
    if (isOpenLikeShellCommand(command)) return 'Opening file...';
    if (/\b(npm|pnpm|yarn)\s+(run\s+)?(build|dev|start|test)\b/i.test(command)) return 'Running project task...';
    if (/\b(python3?|node)\b/i.test(command)) return 'Running local script...';
    if (/\b(mkdir|cp|mv|rm|gio\s+trash|find)\b/i.test(command)) return 'Updating local files...';
    return 'Working locally...';
  };

  if (request.name === 'check_email') {
    const count = Math.min(Math.max(typeof args.count === 'number' ? args.count : 5, 1), 10);
    flash('Checking emails...');
    try {
      const { fetchRecentEmails } = await import('./emailService');
      const emailConfig = settings.email ?? { enabled: false, provider: 'gmail', username: '', password: '' };
      const emails = await withTimeout(fetchRecentEmails(emailConfig, count), 12_000, 'Email check timed out');
      if (agentEntry) {
        agentEntry.state.emails = emails;
        persistAgentStateSnapshot(agentEntry.state, 'realtime-email-fetched');
      }
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: true,
        emailCount: emails.length,
        outputChars: emails.length === 0 ? 'No emails found in your inbox.'.length : undefined
      });
      return {
        commandLabel: 'Checking emails...',
        output: emails.length === 0
          ? 'No emails found in your inbox.'
          : emails.map((email, index) => {
              const attachments = email.attachments.length ? `\nAttachments: ${email.attachments.join(', ')}` : '';
              return `Email #${index + 1}\nFrom: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\nPreview: ${email.preview}${attachments}`;
            }).join('\n\n')
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        error: message
      });
      return {
        commandLabel: 'Email check failed',
        output: `Email check failed. I tried to access your configured inbox, but the email tool returned this error: ${message}`
      };
    }
  }

  if (request.name === 'execute_bash_command') {
    let command = typeof args.command === 'string' ? args.command : '';
    const isDesktopCleanup = !!agentEntry && transcriptRequestsDesktopCleanup(agentEntry.state.transcript);
    if (isDesktopCleanup) {
      if (command !== buildDesktopCleanupCommand()) {
        logAgentRunEvent(agentId, 'tool_arguments_repaired', {
          name: request.name,
          reason: 'force_desktop_only_cleanup_command',
          originalCommand: trimLogText(command)
        });
      }
      command = buildDesktopCleanupCommand();
    }
    if (!command && agentEntry) {
      const inferred = inferOpenGeneratedAppCommand(agentEntry.state.transcript, agentEntry.state.generatedAppPath) ??
        inferOpenLastDownloadedCommand(agentEntry.state.transcript, agentEntry.state.lastDownloadedPath);
      if (inferred) {
        command = inferred;
      }
    }
    if (!command) {
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        error: 'Missing command'
      });
      return { output: 'Shell command failed: missing command.', kind: 'failed' };
    }

    const progressLabel = shellProgressLabel(command);
    flash(progressLabel);
    const result = await executeShellCommand(command);
    logAgentRunEvent(agentId, 'realtime_tool_result', {
      name: request.name,
      ok: !result.error,
      command,
      stdout: trimLogText(result.stdout),
      stderr: trimLogText(result.stderr),
      error: result.error
    });
    const terminalLocalAction = !result.error && isTerminalLocalActionCommand(command);
    if (terminalLocalAction) {
      const userMessage = formatTerminalLocalActionCompletion(command, result);
      return {
        commandLabel: progressLabel,
        output: `Command executed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`.trim(),
        kind: 'sideEffectOnly',
        done: true,
        userMessage
      };
    }
    return {
      commandLabel: progressLabel,
      output: `Command executed.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}${result.error ? `\nERROR:\n${result.error}` : ''}`.trim(),
      kind: result.error ? 'failed' : 'contentBearing',
      done: false
    };
  }

  if (request.name === 'write_file') {
    let filePath = typeof args.file_path === 'string' ? args.file_path : '';
    let content = typeof args.content === 'string' ? args.content : undefined;
    const repairedGeneratedSite = !filePath && content === undefined && agentEntry && transcriptRequestsBuildAction(agentEntry.state.transcript);
    if (repairedGeneratedSite && agentEntry) {
      const generated = await buildFallbackGeneratedSite(agentEntry.state, agentEntry.state.transcript);
      filePath = generated.filePath;
      content = generated.content;
      logAgentRunEvent(agentId, 'tool_arguments_repaired', {
        name: request.name,
        reason: 'missing_write_file_arguments_for_build_request',
        filePath,
        sourceChars: generated.sourceText.length
      });
    }
    if (!filePath || content === undefined) {
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        error: 'Missing file_path or content'
      });
      return { output: 'File write failed: missing file_path or content.' };
    }

    const progressLabel = 'Creating local files...';
    flash(progressLabel);
    try {
      const writtenPath = await writeGeneratedFile(filePath, content);
      if (agentEntry) {
        agentEntry.state.generatedAppPath = writtenPath;
        persistAgentStateSnapshot(agentEntry.state, 'generated-app-written');
      }
      let autoOpenNote = '';
      if (agentEntry) {
        const openCommand = inferOpenGeneratedAppCommand(agentEntry.state.transcript, writtenPath);
        if (openCommand) {
          flash('Opening generated website in browser');
          const openResult = await executeShellCommand(openCommand);
          logAgentRunEvent(agentId, 'realtime_tool_result', {
            name: 'execute_bash_command',
            ok: !openResult.error,
            command: openCommand,
            stdout: trimLogText(openResult.stdout),
            stderr: trimLogText(openResult.stderr),
            error: openResult.error,
            source: 'auto_open_generated_app'
          });
          autoOpenNote = openResult.error
            ? ` I tried to open it, but opening failed: ${openResult.error}`
            : ' I also opened it in a browser tab.';
        }
      }
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: true,
        path: writtenPath,
        chars: content.length,
        repaired: repairedGeneratedSite
      });
      return {
        commandLabel: progressLabel,
        output: `File written successfully: ${writtenPath}.${autoOpenNote}`,
        kind: autoOpenNote.includes('I also opened') ? 'sideEffectOnly' : 'contentBearing',
        done: autoOpenNote.includes('I also opened'),
        userMessage: autoOpenNote.includes('I also opened') ? 'Built it and opened it in a browser tab.' : undefined
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        path: filePath,
        error: message
      });
      return { commandLabel: progressLabel, output: `File write failed: ${message}`, kind: 'failed' };
    }
  }

  if (request.name === 'read_file') {
    const requestedPath = typeof args.path === 'string' ? args.path : '';
    const maxChars = typeof args.max_chars === 'number' ? Math.max(1000, Math.min(args.max_chars, 50000)) : 12000;
    const filePath = requestedPath || extractAbsolutePathFromText(agentEntry?.state.transcript ?? '') || agentEntry?.state.lastDownloadedPath || '';
    if (!filePath) {
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        error: 'Missing path'
      });
      return { output: 'File read failed: missing path and no last downloaded file is available.', kind: 'failed' };
    }
    const progressLabel = 'Reading file...';
    flash(progressLabel);
    try {
      const text = (await readDownloadedDocumentText(filePath)).slice(0, maxChars);
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: true,
        path: filePath,
        chars: text.length
      });
      return {
        commandLabel: progressLabel,
        output: text ? `File: ${filePath}\n\n${text}` : `File ${filePath} was readable but contained no text.`
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        path: filePath,
        error: message
      });
      return { commandLabel: progressLabel, output: `File read failed: ${message}`, kind: 'failed' };
    }
  }

  if (request.name === 'open_file') {
    const requestedPath = typeof args.path === 'string' ? args.path : '';
    const filePath = requestedPath || extractAbsolutePathFromText(agentEntry?.state.transcript ?? '') || agentEntry?.state.lastDownloadedPath || '';
    if (!filePath) {
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        error: 'Missing path'
      });
      return { output: 'Open file failed: missing path and no last downloaded file is available.', kind: 'failed' };
    }
    const progressLabel = 'Opening file...';
    flash(progressLabel);
    try {
      if (!isE2EMode()) {
        const openResult = await executeShellCommand(buildOpenFileCommand(filePath));
        if (openResult.error) throw new Error(openResult.error);
      }
      logAgentRunEvent(agentId, 'realtime_tool_result', { name: request.name, ok: true, path: filePath });
      return {
        commandLabel: progressLabel,
        output: `Opened file: ${filePath}`,
        kind: 'sideEffectOnly',
        done: true,
        userMessage: 'Opened it.'
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', { name: request.name, ok: false, path: filePath, error: message });
      return { commandLabel: progressLabel, output: `Open file failed: ${message}`, kind: 'failed' };
    }
  }

  if (request.name === 'open_url') {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url) {
      return { output: 'Open URL failed: missing url.', kind: 'failed' };
    }
    const progressLabel = 'Opening link...';
    flash(progressLabel);
    try {
      await shell.openExternal(url);
      logAgentRunEvent(agentId, 'realtime_tool_result', { name: request.name, ok: true, url });
      return {
        commandLabel: progressLabel,
        output: 'The link has been opened in the default browser.',
        kind: 'sideEffectOnly',
        done: true,
        userMessage: 'Opened the link.'
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', { name: request.name, ok: false, url, error: message });
      return { commandLabel: progressLabel, output: `Open URL failed: ${message}`, kind: 'failed' };
    }
  }

  if (request.name === 'scrape_website') {
    const url = typeof args.url === 'string' ? args.url : '';
    if (!url) {
      return { output: 'Website scrape failed: missing url.' };
    }
    const progressLabel = 'Reading website...';
    flash(progressLabel);
    try {
      const result = await scrapeWebsite({
        url,
        extractMode: args.extractMode === 'text' ? 'text' : 'markdown',
        maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
      });
      const prefix = result.title ? `# ${result.title}\n\n` : '';
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: true,
        url,
        extractor: result.extractor,
        textChars: result.text.length
      });
      return { commandLabel: progressLabel, output: `${prefix}${result.text}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', { name: request.name, ok: false, url, error: message });
      return { commandLabel: progressLabel, output: `Website scrape failed: ${message}` };
    }
  }

  if (request.name === 'download_email_attachment') {
    let emailNumber = typeof args.email_number === 'number' ? args.email_number : undefined;
    let filename = typeof args.filename === 'string' ? args.filename.trim() : undefined;
    const emailConfig = settings.email ?? { enabled: false, provider: 'gmail', username: '', password: '' };

    let emails = agentEntry?.state.emails ?? [];
    if (emails.length === 0) {
      try {
        const { fetchRecentEmails } = await import('./emailService');
        emails = await withTimeout(fetchRecentEmails(emailConfig, 5), 12_000, 'Email check timed out');
        if (agentEntry) {
          agentEntry.state.emails = emails;
          persistAgentStateSnapshot(agentEntry.state, 'realtime-email-fetched-for-attachment');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logAgentRunEvent(agentId, 'realtime_tool_result', {
          name: request.name,
          ok: false,
          error: `Failed to fetch recent emails for attachment lookup: ${message}`
        });
        return {
          commandLabel: 'Fetching recent emails...',
          output: `I could not fetch recent emails to resolve the attachment. Error: ${message}`,
          kind: 'failed'
        };
      }
    }

    let email = emailNumber && emailNumber > 0 && emailNumber <= emails.length ? emails[emailNumber - 1] : undefined;
    if (!email && emails.length > 0) {
      emailNumber = 1;
      email = emails[0];
    }
    if (!filename && email) {
      const mentioned = email.attachments.find((name) => {
        const normalizedName = name.toLowerCase();
        const normalizedTranscript = (agentEntry?.state.transcript ?? '').toLowerCase();
        return normalizedName.length > 0 && normalizedTranscript.includes(normalizedName);
      });
      filename = mentioned ?? (email.attachments.length === 1 ? email.attachments[0] : undefined);
    }
    if (!email || !filename) {
      const latestAttachmentHelp = emails[0]?.attachments?.length
        ? `Latest email attachments: ${emails[0].attachments.join(', ')}`
        : 'The latest email has no attachments.';
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        error: 'Missing required arguments: email_number and filename',
        knownEmails: emails.length
      });
      return {
        output: `I need the email number and exact attachment filename to download it. ${latestAttachmentHelp}`,
        kind: 'failed'
      };
    }

    const progressLabel = 'Downloading attachment...';
    flash(progressLabel);
    try {
      const { downloadAttachment } = await import('./emailService');
      const destPath = await ensureUniquePath(app.getPath('downloads'), filename);
      await downloadAttachment(emailConfig, email.uid, filename, destPath);
      if (agentEntry) {
        agentEntry.state.lastDownloadedPath = destPath;
        persistAgentStateSnapshot(agentEntry.state, 'realtime-attachment-downloaded');
      }
      let autoOpenNote = '';
      const autoOpenCommand = inferOpenLastDownloadedCommand(agentEntry?.state.transcript ?? '', destPath);
      if (autoOpenCommand) {
        flash('Opening file...');
        const openResult = await executeShellCommand(autoOpenCommand);
        logAgentRunEvent(agentId, 'realtime_tool_result', {
          name: 'execute_bash_command',
          ok: !openResult.error,
          command: autoOpenCommand,
          stdout: trimLogText(openResult.stdout),
          stderr: trimLogText(openResult.stderr),
          error: openResult.error,
          source: 'auto_open_downloaded_attachment'
        });
        autoOpenNote = openResult.error
          ? ` I tried to open it, but opening failed: ${openResult.error}`
          : ' I also opened it for you.';
      }
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: true,
        uid: email.uid,
        filename,
        destPath,
        resolvedEmailNumber: emailNumber
      });
      return {
        commandLabel: progressLabel,
        output: `The attachment "${filename}" has been downloaded to ${destPath}.${autoOpenNote}`,
        kind: autoOpenNote.includes('I also opened') ? 'sideEffectOnly' : 'contentBearing',
        done: autoOpenNote.includes('I also opened'),
        userMessage: autoOpenNote.includes('I also opened') ? 'Downloaded and opened it.' : undefined
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logAgentRunEvent(agentId, 'realtime_tool_result', {
        name: request.name,
        ok: false,
        uid: email.uid,
        filename,
        error: message
      });
      return {
        commandLabel: progressLabel,
        output: `I was unable to download attachment "${filename}". Error: ${message}`,
        kind: 'failed'
      };
    }
  }

  logAgentRunEvent(agentId, 'realtime_tool_result', {
    name: request.name,
    ok: false,
    error: 'Unknown tool'
  });
  return { output: `Unknown tool: ${request.name}`, kind: 'failed' };
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
  const timeoutMs = 20_000;
  try {
    const { stdout, stderr } = await execAsync(command, { shell: '/bin/bash', timeout: timeoutMs });
    return { stdout: stdout.trim(), stderr: stderr.trim(), error: null };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    const timeoutLike = typeof err === 'object' && err !== null && 'killed' in err && !!(err as { killed?: boolean }).killed;
    if (timeoutLike || /timed out/i.test(message)) {
      message = `Command timed out after ${timeoutMs}ms`;
    }
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

type OpenAIMessage = Record<string, unknown>;

type AgentToolCall = {
  id: string;
  name: string;
  arguments: string;
};

const MAX_AGENT_TOOL_STEPS = 8;

function buildRuntimeContextMessage(request: VoiceTurnRequest, state: AgentState): OpenAIMessage {
  const recentEmailContext = (state.emails ?? []).slice(0, 5).map((email, index) => {
    const attachments = email.attachments.length ? ` attachments: ${email.attachments.join(', ')}` : '';
    return `Email #${index + 1}: from ${email.from}; subject ${email.subject};${attachments}`;
  }).join('\n');

  const screenContext = request.captures.length > 0
    ? `Screen captures attached: ${request.captures.map((capture) => `${capture.label} ${capture.width}x${capture.height}`).join(', ')}`
    : 'Screen captures attached: none. The app could not provide visual screen context for this turn; do not claim you can see the screen unless an image is attached.';

  return {
    role: 'system',
    content:
      'RUNTIME STATE FOR THIS TURN:\n' +
      `${screenContext}\n` +
      `Last downloaded file: ${state.lastDownloadedPath ?? 'none'}\n` +
      `Last generated app/site file: ${state.generatedAppPath ?? 'none'}\n` +
      `Recent email cache:\n${recentEmailContext || 'none'}\n` +
      'Use tools dynamically. If a previous tool call failed because required arguments were missing, repair the call with concrete arguments from this runtime state or explain the limitation in the final answer.'
  };
}

function buildInitialAgentMessages(request: VoiceTurnRequest, state: AgentState): OpenAIMessage[] {
  const messages = buildOpenAIMessages(request) as OpenAIMessage[];
  messages.splice(1, 0, buildRuntimeContextMessage(request, state));
  return messages;
}

function appendAssistantToolCallMessage(messages: OpenAIMessage[], content: string, toolCalls: AgentToolCall[]): void {
  messages.push({
    role: 'assistant',
    content: content.trim() ? content : null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments || '{}'
      }
    }))
  });
}

function appendToolResultMessage(messages: OpenAIMessage[], toolCallId: string, output: string): void {
  messages.push({
    role: 'tool',
    tool_call_id: toolCallId,
    content: output
  });
}

function updateAgentConversationHistory(state: AgentState, request: VoiceTurnRequest, assistantContent: string): void {
  state.conversationHistory = [
    ...request.conversationHistory,
    { role: 'user', content: request.transcript },
    { role: 'assistant', content: assistantContent }
  ];
}

function finishAgentStream(
  api: WorkerApi,
  win: BrowserWindow,
  state: AgentState,
  request: VoiceTurnRequest,
  agentId: string,
  fullResponse: string,
  stats: { chunkCount: number; streamedChars: number; commands: string[] },
  reason: string
): void {
  state.status = 'done';
  const split = splitAgentReply(fullResponse);
  state.response = split.spokenText;

  const emailDisplaySummary = Array.isArray(state.emails) && state.emails.length > 0 && /email|inbox|mail/i.test(request.transcript)
    ? buildRecentEmailDisplaySummary(state.emails)
    : undefined;
  if (emailDisplaySummary && !split.displayHeader.trim() && !split.displayCaption.trim()) {
    state.displayHeader = emailDisplaySummary.header;
    state.displayCaption = emailDisplaySummary.caption;
    state.displayDetails = emailDisplaySummary.details;
  } else {
    const llmDisplaySummary = compactDisplaySummary({
      header: split.displayHeader || split.displayCaption || split.spokenText,
      caption: split.displayCaption || split.displayHeader || split.spokenText
    });
    if (split.displayCaption.trim()) {
      state.displayCaption = llmDisplaySummary.caption;
    }
    if (split.displayHeader.trim()) {
      state.displayHeader = llmDisplaySummary.header;
    }
    state.displayDetails = undefined;
  }

  const caption = split.displayCaption.trim();
  const headerLine = split.displayHeader.trim();
  const spokenTrim = split.spokenText.trim();
  const clipped = (t: string) => t.slice(0, 200) + (t.length > 200 ? '...' : '');
  state.summary = caption ? clipped(caption) : headerLine ? clipped(headerLine) : clipped(spokenTrim);
  state.completedAt = Date.now();
  state.actions = [];
  updateAgentConversationHistory(state, request, split.spokenText);

  console.log('[clicky:agent] stream done', {
    agentId,
    reason,
    responseChars: fullResponse.length,
    spokenChars: split.spokenText.length,
    headerChars: split.displayHeader.length,
    captionChars: split.displayCaption.length,
    chunks: stats.chunkCount,
    streamedChars: stats.streamedChars,
    commands: state.commands.length
  });
  logAgentRunEvent(agentId, 'stream_done', {
    reason,
    response: trimLogText(fullResponse),
    spokenText: trimLogText(split.spokenText),
    displayHeader: split.displayHeader,
    displayCaption: split.displayCaption,
    chunks: stats.chunkCount,
    streamedChars: stats.streamedChars,
    commands: stats.commands
  });
  persistAgentStateSnapshot(state, 'stream-done');
  stopAgentSpeech(win, agentId, reason);
  safeSend(win, ipcChannels.chatDone);
  safeSend(win, ipcChannels.agentUpdate, state);
  if (split.spokenText) {
    speakWithOpenAiInBackground(api, win, agentId, split.spokenText, 'response');
  }
}

function formatLocalToolCompletion(message: string): string {
  return `<<<HEADER>>>\nDone\n<<<UI>>>\n${message}\n<<<SPOKEN>>>\n${message}`;
}

async function collectModelStep(
  api: WorkerApi,
  model: string,
  messages: OpenAIMessage[],
  win: BrowserWindow,
  state: AgentState,
  agentId: string,
  stats: { chunkCount: number; streamedChars: number }
): Promise<{ content: string; toolCalls: AgentToolCall[] }> {
  let content = '';
  const toolCalls: AgentToolCall[] = [];
  const chatChunks = createChatChunkFlusher(win);

  try {
    for await (const event of api.sendMessages(messages, model)) {
      if (event.type === 'chunk' && event.text) {
        stats.chunkCount++;
        stats.streamedChars += event.text.length;
        content += event.text;
        const commandMatch = event.text.match(/(?:^|\n)(?:\$\s+)?(ls\s+|sed\s+|mkdir\s+|cd\s+|cp\s+|mv\s+|rm\s+|git\s+|npm\s+|pip\s+|python\s+|node\s+)[^\n]+/);
        if (commandMatch) {
          state.commands.push(commandMatch[0].trim());
          logAgentRunEvent(agentId, 'command_detected_in_stream', { command: commandMatch[0].trim() });
          safeSend(win, ipcChannels.agentCommandFlash, commandMatch[0].trim());
        }
        chatChunks.append(event.text);
      } else if (event.type === 'tool_call' && event.name) {
        chatChunks.flush();
        toolCalls.push({
          id: event.id || `tool_${randomUUID()}`,
          name: event.name,
          arguments: event.arguments || '{}'
        });
      } else if (event.type === 'error' && event.error) {
        throw new Error(event.error);
      }
    }
  } finally {
    chatChunks.dispose();
  }

  return { content, toolCalls };
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
  logAgentRunEvent(agentId, 'stream_started', {
    transcript: trimLogText(request.transcript),
    captures: request.captures.map(({ label, width, height }) => ({ label, width, height })),
    model: request.model,
    history: request.conversationHistory.length
  });

  const messages = buildInitialAgentMessages(request, state);
  const stats = { chunkCount: 0, streamedChars: 0, commands: state.commands };

  try {
    for (let step = 0; step < MAX_AGENT_TOOL_STEPS; step++) {
      const { content, toolCalls } = await collectModelStep(api, request.model, messages, win, state, agentId, stats);

      if (toolCalls.length === 0) {
        finishAgentStream(api, win, state, request, agentId, content, stats, `final-step-${step}`);
        return;
      }

      appendAssistantToolCallMessage(messages, content, toolCalls);
      for (const toolCall of toolCalls) {
        console.log('[clicky:agent] TOOL_CALL received', {
          agentId,
          id: toolCall.id,
          name: toolCall.name,
          argsChars: toolCall.arguments.length
        });
        logAgentRunEvent(agentId, 'tool_call', {
          id: toolCall.id,
          name: toolCall.name,
          arguments: trimLogText(toolCall.arguments)
        });
        let toolOutput: string;
        try {
          const result = await executeRealtimeToolRequest({
            name: toolCall.name,
            arguments: toolCall.arguments,
            agentId
          });
          if (result.done && result.kind === 'sideEffectOnly') {
            const userMessage = result.userMessage || result.output || 'Done.';
            logAgentRunEvent(agentId, 'local_tool_completion', {
              id: toolCall.id,
              name: toolCall.name,
              message: userMessage
            });
            finishAgentStream(api, win, state, request, agentId, formatLocalToolCompletion(userMessage), stats, `local-tool-${toolCall.name}`);
            return;
          }
          toolOutput = result.output;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolOutput = `Tool ${toolCall.name} failed before execution completed: ${message}`;
          logAgentRunEvent(agentId, 'tool_result', {
            id: toolCall.id,
            name: toolCall.name,
            ok: false,
            error: message
          });
        }
        appendToolResultMessage(messages, toolCall.id, toolOutput);
      }
    }

    const limitMessage = 'I reached the tool step limit before completing the task. I stopped to avoid looping.';
    finishAgentStream(api, win, state, request, agentId, `<<<HEADER>>>\nTool limit reached\n<<<UI>>>\n${limitMessage}\n<<<SPOKEN>>>\n${limitMessage}`, stats, 'tool-step-limit');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.status = 'error';
    state.error = message;
    console.error('[clicky:agent] stream error', { agentId, error: message });
    logAgentRunEvent(agentId, 'stream_error', { error: message });
    persistAgentStateSnapshot(state, 'stream-error');
    safeSend(win, ipcChannels.chatError, message);
    safeSend(win, ipcChannels.agentUpdate, state);
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  console.log('[clicky:timeout] wrapping call with', ms, 'ms timeout');
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      console.log('[clicky:timeout] TIMEOUT FIRED:', message);
      console.log('[clicky:timeout] rejecting with', message);
      reject(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
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

async function tryGnomeShellScreenshot(): Promise<ScreenCapturePayload | null> {
  if (!isWayland()) return null;
  try {
    const tmpPath = join(tmpdir(), `clicky-screenshot-${randomUUID()}.jpg`);
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    await execFileAsync('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.gnome.Shell',
      '--object-path',
      '/org/gnome/Shell/Screenshot',
      '--method',
      'org.gnome.Shell.Screenshot.Screenshot',
      'false',
      'false',
      tmpPath
    ], { timeout: 10000 });
    const jpegBuffer = await readFile(tmpPath);
    await unlink(tmpPath).catch(() => {});
    return {
      jpegBase64: jpegBuffer.toString('base64'),
      label: 'Linux screen (gnome-shell)',
      width,
      height
    };
  } catch {
    return null;
  }
}

async function tryGnomeScreenshotBinary(): Promise<ScreenCapturePayload | null> {
  if (!isWayland()) return null;
  try {
    const tmpPath = join(tmpdir(), `clicky-screenshot-${randomUUID()}.jpg`);
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    await execFileAsync('gnome-screenshot', ['-f', tmpPath], { timeout: 10000 });
    const jpegBuffer = await readFile(tmpPath);
    await unlink(tmpPath).catch(() => {});
    return {
      jpegBase64: jpegBuffer.toString('base64'),
      label: 'Linux screen (gnome-screenshot)',
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
    const gnomeShellResult = await tryGnomeShellScreenshot();
    if (gnomeShellResult) {
      console.log('[clicky:capture] screenshot taken via gnome-shell screenshot dbus');
      return gnomeShellResult;
    }
    const gnomeScreenshotResult = await tryGnomeScreenshotBinary();
    if (gnomeScreenshotResult) {
      console.log('[clicky:capture] screenshot taken via gnome-screenshot');
      return gnomeScreenshotResult;
    }
    console.warn('[clicky:capture] linux screenshot backends failed; skipping capture to avoid system screen-share picker');
    throw new Error('Wayland screenshot unavailable without system picker');
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
  const api = createAgentWorkerApi();
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

ipcMain.handle(ipcChannels.realtimeCreateAgentCall, async (_event, offerSdp: string) => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  return api.createRealtimeAgentCall(offerSdp);
});

ipcMain.handle(ipcChannels.realtimeExecuteTool, async (_event, request: RealtimeToolRequest): Promise<RealtimeToolResponse> => {
  return executeRealtimeToolRequest(request);
});

ipcMain.handle(ipcChannels.ttsSpeak, async (_event, text: string, agentId?: string) => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  const targetWindow = agentId ? agents.get(agentId)?.window : undefined;
  const sequence = agentId ? (ttsSequenceByAgent.get(agentId) ?? 0) + 1 : 0;
  if (agentId) {
    ttsSequenceByAgent.set(agentId, sequence);
  }
  if (agentId) {
    logAgentRunEvent(agentId, 'tts_request', { reason: 'direct', text: trimLogText(text), chars: text.length });
  }
  try {
    const audio = await api.synthesizeSpeech(text);
    if (agentId && ttsSequenceByAgent.get(agentId) !== sequence) {
      logAgentRunEvent(agentId, 'tts_skipped_stale_direct', { sequence });
      return;
    }
    safeSend(targetWindow, ipcChannels.ttsAudio, audio);
    if (agentId) {
      logAgentRunEvent(agentId, 'tts_audio_sent', { reason: 'direct', bytes: audio.byteLength });
    }
  } catch (error) {
    if (agentId) {
      logAgentRunEvent(agentId, 'tts_error', { reason: 'direct', error: error instanceof Error ? error.message : String(error) });
    }
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
    displayCaption: '',
    displayHeader: '',
    displayDetails: undefined,
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
  logAgentRunEvent(agentId, 'agent_spawn', {
    transcript: request.transcript,
    captures: request.captures.map(({ label, width, height }) => ({ label, width, height })),
    model: request.model
  });
  persistAgentStateSnapshot(state, 'spawn');

  win.webContents.on('did-finish-load', () => {
    console.log('[clicky:agent] renderer loaded; sending initial state', { agentId });
    safeSend(win, ipcChannels.agentUpdate, state);
  });

  const api = createAgentWorkerApi();
  try {
    await waitForWindowLoad(win);
    speakTaskAcknowledgement(api, win, agentId, request.transcript);
    await processAgentStream(api, { ...request, agentId }, win, state, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[clicky:agent] processAgentStream threw', { agentId, error: message });
    state.status = 'error';
    state.error = message;
    logAgentRunEvent(agentId, 'stream_exception', { error: message });
    persistAgentStateSnapshot(state, 'stream-exception');
    safeSend(win, ipcChannels.chatError, message);
    safeSend(win, ipcChannels.agentUpdate, state);
  }

  return agentId;
});

ipcMain.handle(ipcChannels.agentSpawnRealtime, (_event, request: VoiceTurnRequest): string => {
  console.log('[clicky:agent] realtime spawn requested', {
    transcript: request.transcript,
    captures: request.captures.length
  });
  return createRealtimeAgent(request);
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

ipcMain.handle(ipcChannels.agentGetContext, (_event, agentId: string): AgentState | undefined => {
  const state = agents.get(agentId)?.state;
  console.log('[clicky:agent] get state requested', { agentId, found: !!state });
  return state;
});

ipcMain.handle(ipcChannels.agentSetExpanded, (_event, agentId: string, expanded: boolean) => {
  setAgentWindowExpanded(agentId, expanded);
  logAgentRunEvent(agentId, 'window_expanded_changed', { expanded });
});

ipcMain.on(ipcChannels.agentReportState, (event, state: AgentState, reason: string) => {
  const entry = agents.get(state.id);
  if (!entry || event.sender.id !== entry.window.webContents.id) return;
  entry.state = state;
  if (reason === 'realtime-state' && state.status === 'running') return;
  persistAgentStateSnapshot(state, reason || 'renderer-report');
});

ipcMain.on(ipcChannels.agentLogEvent, (event, agentId: string, type: string, details?: unknown) => {
  const entry = agents.get(agentId);
  if (!entry || event.sender.id !== entry.window.webContents.id) return;
  logAgentRunEvent(agentId, type, details);
});

ipcMain.handle(ipcChannels.windowGetContext, (event): WindowContext | undefined => {
  return windowContexts.get(event.sender.id);
});

if (isE2EMode()) {
  fakeWorkerApi = createFakeWorkerApi();
  const { registerE2EIpcHandlers } = await import('../test-helpers/e2e-mode');
  registerE2EIpcHandlers(
    ipcMain as unknown as { handle(channel: string, listener: (event: unknown, ...args: any[]) => any): void },
    safeSend as (win: unknown, channel: string, ...args: unknown[]) => void,
    openRecorderOrb,
    () => recorderWindow as unknown as { isDestroyed(): boolean; close(): void } | undefined,
    () => recorderWindowReady,
    agents as unknown as Map<string, any>,
  );
  console.log('[clicky:e2e] E2E IPC handlers registered');
}

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

ipcMain.on(ipcChannels.cursorPosition, (event, x: number, y: number) => {
  if (event.sender.id !== recorderWindow?.webContents.id) return;
  lastRendererCursorPos = { x, y };
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
  state.displayCaption = '';
  state.displayHeader = '';
  state.displayDetails = undefined;
  state.summary = '';
  state.commands = [];
  state.error = undefined;
  state.completedAt = undefined;
  state.conversationHistory = request.conversationHistory;
  logAgentRunEvent(agentId, 'agent_follow_up', {
    transcript: request.transcript,
    captures: request.captures.map(({ label, width, height }) => ({ label, width, height })),
    model: request.model,
    history: request.conversationHistory.length
  });
  persistAgentStateSnapshot(state, 'follow-up-started');
  safeSend(win, ipcChannels.agentUpdate, state);

  const api = createAgentWorkerApi();
  try {
    speakTaskAcknowledgement(api, win, agentId, request.transcript);
    await processAgentStream(api, { ...request, agentId }, win, state, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[clicky:agent] follow-up stream threw', { agentId, error: message });
    state.status = 'error';
    state.error = message;
    logAgentRunEvent(agentId, 'follow_up_exception', { error: message });
    persistAgentStateSnapshot(state, 'follow-up-exception');
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
