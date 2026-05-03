import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSettings, saveSettings } from './settings';
import { WorkerApi } from './workerApi';
import { ipcChannels } from '../shared/ipcChannels';
import type { AppSettings, CaptureSource, VoiceTurnRequest, AgentState, WindowContext, AgentAction, ScreenCapturePayload, ShellResult, RecordedAudioPayload } from '../shared/types';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
let wakeRuntime: WakeRuntime | undefined;

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

app.commandLine.appendSwitch('no-sandbox');

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let envLoaded = false;
let tray: Tray | undefined;
let settings: AppSettings;
let recorderWindow: BrowserWindow | undefined;
let recorderWindowReady = false;
let wakeWordService: WakeWordService | undefined;
const agents = new Map<string, { window: BrowserWindow; state: AgentState }>();
const windowContexts = new Map<number, WindowContext>();
const DEFAULT_VOSK_MODEL_DIR = 'vosk-model-small-en-us';
const DEFAULT_VOSK_MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';

interface NodeRecordLpcm16Module {
  record(options: {
    sampleRateHertz: number;
    threshold: number;
    verbose: boolean;
    recordProgram?: string;
    device?: string;
    channels?: number;
    audioType?: string;
    endOnSilence?: boolean;
  }): {
    stream(): NodeJS.ReadableStream;
    stop(): void;
  };
}

interface WakeRuntime {
  vosk: typeof import('vosk');
  record: NodeRecordLpcm16Module;
}

function getWakeRuntime(): WakeRuntime {
  if (wakeRuntime) {
    return wakeRuntime;
  }

  wakeRuntime = {
    vosk: require('vosk') as typeof import('vosk'),
    record: require('node-record-lpcm16') as NodeRecordLpcm16Module
  };
  return wakeRuntime;
}

function safeSend(win: BrowserWindow | undefined, channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

async function initApp(): Promise<void> {
  console.log('[clicky:main] app init started');
  await loadDotEnv();
  settings = await loadSettings();
  console.log('[clicky:main] settings loaded', {
    workerBaseUrl: settings.workerBaseUrl,
    model: settings.model,
    selectedCaptureSourceLabel: settings.selectedCaptureSourceLabel
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
  }, { useSystemPicker: true });

  createTray();
  startWakeWordListener();
}

function createTray(): void {
  try {
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAxklEQVR4nJ2TsQ3CMAxF3w0wARsQG7ACG7ABG7ABG7ABG7ABG7ABG7ABG1AQEmioUqRKkZzYTvb9+66fYAIz6wVcAE6Bm8A84GgAdwUTYAG8Avc8y0bB3wJNgcZJY1MFXgP7GNcAUWAvkU2bmQEcA49knu8D1QU+knkVAhvJLJ8k2QX4QmZ5JsmDgGuS7AQ8AvuZ5zW5rQT2Emkb7XVQo7XRNE0doKx9FUQQnJTp3A3wDTcxdYvVw/Rm3AAAAAElFTkSuQmCC'
    );
      tray = new Tray(icon);
    if (!tray.isDestroyed()) {
      tray.setToolTip('Clicky');
      tray.on('click', () => console.log('[clicky:tray] tray clicked; app is wake-word triggered only'));
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
      { label: 'Restart Wake Listener', click: startWakeWordListener },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]));
  } catch (err) {
    console.error('[clicky:tray] tray menu update failed:', err);
  }
}

function handleWakeWordDetected(keywordLabel: string): void {
  console.log('[clicky:wake] wake word detected; opening recorder orb', { keywordLabel });
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    console.warn('[clicky:wake] recorder orb is already open; ignoring wake event');
    return;
  }
  recorderWindowReady = false;
  createOrbWindow(keywordLabel);
}

function createOrbWindow(keywordLabel: string): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const size = 120;
  const margin = 12;

  let x = cursor.x + margin;
  let y = cursor.y - size / 2;

  const bounds = display.workArea;
  x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - size));
  y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - size));

  console.log('[clicky:orb] creating orb window', {
    cursor,
    display: display.id,
    x,
    y,
    size
  });

  const win = new BrowserWindow({
    width: size,
    height: size,
    x,
    y,
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
      recorderWindowReady = true;
      safeSend(win, ipcChannels.recordingStart);
      console.log('[clicky:orb] window shown and recording start sent', { keywordLabel });
    }
  }).catch((err) => {
    console.error('[clicky:orb] renderer load failed:', err);
    wakeWordService?.resume();
  });

  win.on('closed', () => {
    windowContexts.delete(winId);
    recorderWindow = undefined;
    recorderWindowReady = false;
    console.log('[clicky:orb] window closed and context removed', { winId });
    wakeWordService?.resume();
  });
}

function createAgentWindow(agentId: string): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const margin = 20;
  const width = 380;
  const height = 440;
  const x = primary.workArea.x + primary.workArea.width - width - margin;
  const y = primary.workArea.y + margin + (agents.size * (height + margin));
  console.log('[clicky:agent] creating agent window', { agentId, x, y, width, height });

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: undefined,
    hasShadow: true,
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
  windowContexts.set(winId, { type: 'agent', agentId });
  console.log('[clicky:agent] window context registered', { agentId, winId });

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
    windowContexts.delete(winId);
    console.log('[clicky:agent] window closed and state removed', { agentId, winId });
  });

  return win;
}

function buildDefaultActions(transcript: string): AgentAction[] {
  const actions: AgentAction[] = [{ id: 'copy', label: 'Copy Response', type: 'copy' }];
  if (transcript.toLowerCase().includes('reminder')) {
    actions.push({ id: 'open-reminders', label: 'Open Reminders', type: 'open_app', payload: 'reminders' });
  }
  if (transcript.toLowerCase().includes('desktop') || transcript.toLowerCase().includes('file') || transcript.toLowerCase().includes('folder')) {
    actions.push({ id: 'open-folder', label: 'Open Folder', type: 'open_folder', payload: app.getPath('desktop') });
  }
  return actions;
}

function createErrorAgent(message: string): string {
  const agentId = randomUUID();
  console.log('[clicky:agent] creating error agent', { agentId, message });
  const win = createAgentWindow(agentId);
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
    completedAt: Date.now()
  };

  agents.set(agentId, { window: win, state });
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
    form.append('model', 'whisper-1');
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

function startWakeWordListener(): void {
  try {
    wakeWordService?.stop();
    const config = getWakeWordConfig();
    if (!config) return;
    wakeWordService = new WakeWordService(config, handleWakeWordDetected);
    void wakeWordService.start();
  } catch (err) {
    console.error('[clicky:wake] wake listener failed to start', err);
  }
}

interface WakeWordConfig {
  modelPath: string;
  sampleRate: number;
  recordProgram?: string;
  device?: string;
  wakePhrases: string[];
  debounceMs: number;
}

function getWakeWordConfig(): WakeWordConfig | undefined {
  const modelPath = resolveVoskModelPath();
  if (!modelPath) {
    console.warn('[clicky:wake] wake word listener not started; download the Vosk model first.');
    console.warn('[clicky:wake] expected model directory name', {
      modelDir: DEFAULT_VOSK_MODEL_DIR,
      script: 'npm run setup:vosk-model',
      url: DEFAULT_VOSK_MODEL_URL
    });
    return undefined;
  }
  const wakePhrases = splitEnvList(process.env.CLICKY_WAKE_PHRASES);
  const normalizedWakePhrases = wakePhrases.length > 0 ? wakePhrases : ['hey clicky', 'clicky'];
  const sampleRate = Number.parseInt(process.env.CLICKY_WAKE_SAMPLE_RATE ?? '16000', 10);
  const debounceMs = Number.parseInt(process.env.CLICKY_WAKE_DEBOUNCE_MS ?? '2500', 10);
  const recordProgram = process.env.CLICKY_WAKE_RECORD_PROGRAM ?? (process.platform === 'linux' ? 'arecord' : undefined);
  const device = process.env.CLICKY_WAKE_DEVICE?.trim() || undefined;
  console.log('[clicky:wake] wake word config loaded', {
    modelPath,
    sampleRate,
    recordProgram,
    device,
    wakePhrases: normalizedWakePhrases,
    debounceMs
  });
  return {
    modelPath,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : 16000,
    recordProgram,
    device,
    wakePhrases: normalizedWakePhrases.map((item) => item.toLowerCase()),
    debounceMs: Number.isFinite(debounceMs) ? debounceMs : 2500
  };
}

function splitEnvList(value: string | undefined): string[] {
  return value?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function resolveVoskModelPath(): string | undefined {
  const configured = process.env.CLICKY_VOSK_MODEL_PATH?.trim();
  const candidateRoots = [
    configured,
    join(process.cwd(), 'models', DEFAULT_VOSK_MODEL_DIR),
    join(app.getAppPath(), 'models', DEFAULT_VOSK_MODEL_DIR),
    join(process.resourcesPath, 'models', DEFAULT_VOSK_MODEL_DIR)
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidateRoots) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const rootDirectories = [
    join(process.cwd(), 'models'),
    join(app.getAppPath(), 'models'),
    join(process.resourcesPath, 'models')
  ];
  for (const root of rootDirectories) {
    try {
      const match = readdirSync(root)
        .find((entry) => entry.startsWith('vosk-model-small-en-us'));
      if (match) {
        return join(root, match);
      }
    } catch {
      void 0;
    }
  }

  return undefined;
}

function extractTranscript(payload: unknown): string {
  if (!payload) return '';

  if (typeof payload === 'string') {
    try {
      return extractTranscript(JSON.parse(payload));
    } catch {
      return payload;
    }
  }

  if (typeof payload === 'object') {
    const candidate = payload as { text?: unknown; partial?: unknown };
    if (typeof candidate.text === 'string') return candidate.text;
    if (typeof candidate.partial === 'string') return candidate.partial;
  }

  return '';
}

class WakeWordService {
  private runtime?: WakeRuntime;
  private model?: import('vosk').Model;
  private recognizer?: import('vosk').Recognizer;
  private recorder?: ReturnType<NodeRecordLpcm16Module['record']>;
  private audioStream?: NodeJS.ReadableStream;
  private running = false;
  private listening = false;
  private lastWakeAt = 0;

  constructor(
    private readonly config: WakeWordConfig,
    private readonly onWake: (keywordLabel: string) => void
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    console.log('[clicky:wake] initializing local Vosk wake-word listener');
    this.runtime = getWakeRuntime();
    this.runtime.vosk.setLogLevel(0);
    this.model = new this.runtime.vosk.Model(this.config.modelPath);
    this.running = true;
    this.resume();
  }

  stop(): void {
    this.running = false;
    this.stopCapture();
    try {
      this.recognizer?.free();
    } catch {
      void 0;
    }
    try {
      this.model?.free();
    } catch {
      void 0;
    }
    this.recognizer = undefined;
    this.model = undefined;
    console.log('[clicky:wake] local wake-word listener stopped');
  }

  resume(): void {
    if (!this.running || this.listening || !this.model || !this.runtime) return;
    this.recognizer = new this.runtime.vosk.Recognizer({ model: this.model, sampleRate: this.config.sampleRate });
    this.recorder = this.runtime.record.record({
      sampleRateHertz: this.config.sampleRate,
      threshold: 0,
      verbose: false,
      recordProgram: this.config.recordProgram,
      device: this.config.device,
      channels: 1,
      audioType: 'raw',
      endOnSilence: false
    });
    this.audioStream = this.recorder.stream();
    this.audioStream.on('data', this.handleAudioChunk);
    this.audioStream.on('error', this.handleStreamError);
    this.audioStream.on('close', this.handleStreamClose);
    this.listening = true;
    console.log('[clicky:wake] local wake-word listener started', {
      sampleRate: this.config.sampleRate,
      recordProgram: this.config.recordProgram,
      device: this.config.device,
      wakePhrases: this.config.wakePhrases
    });
  }

  pause(): void {
    if (!this.running || !this.listening) return;
    this.stopCapture();
    console.log('[clicky:wake] local wake-word listener paused');
  }

  private stopCapture(): void {
    this.audioStream?.off('data', this.handleAudioChunk);
    this.audioStream?.off('error', this.handleStreamError);
    this.audioStream?.off('close', this.handleStreamClose);
    this.audioStream = undefined;
    try {
      this.recorder?.stop();
    } catch {
      void 0;
    }
    this.recorder = undefined;
    try {
      this.recognizer?.free();
    } catch {
      void 0;
    }
    this.recognizer = undefined;
    this.listening = false;
  }

  private readonly handleAudioChunk = (chunk: Buffer): void => {
    if (!this.running || !this.listening || !this.recognizer) return;
    try {
      const accepted = this.recognizer.acceptWaveform(chunk);
      const transcript = extractTranscript(accepted ? this.recognizer.result() : this.recognizer.partialResult())
        .trim()
        .toLowerCase();
      if (!transcript) return;

      const matchedPhrase = this.config.wakePhrases.find((phrase) => transcript.includes(phrase));
      if (!matchedPhrase) return;

      const now = Date.now();
      if (now - this.lastWakeAt < this.config.debounceMs) {
        return;
      }

      this.lastWakeAt = now;
      console.log('[clicky:wake] local wake phrase matched', {
        transcript,
        matchedPhrase
      });
      this.pause();
      this.onWake(matchedPhrase);
    } catch (err) {
      console.error('[clicky:wake] wake listener chunk processing failed', err);
      this.pause();
    }
  };

  private readonly handleStreamError = (err: unknown): void => {
    console.error('[clicky:wake] wake listener stream failed', err);
    this.pause();
  };

  private readonly handleStreamClose = (): void => {
    if (!this.running || !this.listening) return;
    console.warn('[clicky:wake] wake listener stream closed unexpectedly');
    this.pause();
  };
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
  for await (const event of api.sendTurn(request)) {
    console.log('[clicky:agent] stream event received', {
      agentId,
      type: event.type,
      chunkChars: event.text?.length,
      toolName: event.name
    });
    if (event.type === 'chunk' && event.text) {
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
      safeSend(win, ipcChannels.chatChunk, event.text);
    } else if (event.type === 'tool_call' && event.name === 'execute_bash_command') {
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
    } else if (event.type === 'done') {
      state.status = 'done';
      state.response = fullResponse;
      state.summary = fullResponse.slice(0, 200) + (fullResponse.length > 200 ? '...' : '');
      state.completedAt = Date.now();
      state.actions = buildDefaultActions(request.transcript);
      console.log('[clicky:agent] stream done', {
        agentId,
        responseChars: fullResponse.length,
        commands: state.commands.length,
        actions: state.actions.map((action) => action.label)
      });
      safeSend(win, ipcChannels.chatDone);
      safeSend(win, ipcChannels.agentUpdate, state);
      if (fullResponse) {
        try {
          console.log('[clicky:agent] requesting TTS audio', { agentId, chars: fullResponse.length });
          const audio = await api.synthesizeSpeech(fullResponse);
          safeSend(win, ipcChannels.ttsAudio, audio);
          console.log('[clicky:agent] TTS audio sent', { agentId, bytes: audio.byteLength });
        } catch {
          console.warn('[clicky:agent] TTS synthesis failed', { agentId });
          void 0;
        }
      }
    } else if (event.type === 'error' && event.error) {
      state.status = 'error';
      state.error = event.error;
      console.error('[clicky:agent] stream error', { agentId, error: event.error });
      safeSend(win, ipcChannels.chatError, event.error);
      safeSend(win, ipcChannels.agentUpdate, state);
    }
  }
}

ipcMain.handle(ipcChannels.settingsGet, () => settings);
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

ipcMain.handle(ipcChannels.captureTakeScreenshot, async (): Promise<ScreenCapturePayload> => {
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
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  return api.getTranscribeToken();
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
    createdAt: Date.now()
  };

  agents.set(agentId, { window: win, state });
  console.log('[clicky:agent] state stored', { agentId });
  wakeWordService?.resume();

  win.webContents.on('did-finish-load', () => {
    console.log('[clicky:agent] renderer loaded; sending initial state', { agentId });
    safeSend(win, ipcChannels.agentUpdate, state);
  });

  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  try {
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
  wakeWordService?.resume();
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
  }
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

app.whenReady().then(initApp);
app.on('will-quit', () => {
  wakeWordService?.stop();
});
app.on('window-all-closed', () => {
  void 0;
});
