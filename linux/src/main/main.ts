import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron';
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
    selectedCaptureSourceLabel: settings.selectedCaptureSourceLabel,
    email: settings.email
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

  createTray();
  registerPushToTalkShortcut();
}

function createTray(): void {
  try {
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAxklEQVR4nJ2TsQ3CMAxF3w0wARsQG7ACG7ABG7ABG7ABG7ABG7ABG7ABG1AQEmioUqRKkZzYTvb9+66fYAIz6wVcAE6Bm8A84GgAdwUTYAG8Avc8y0bB3wJNgcZJY1MFXgP7GNcAUWAvkU2bmQEcA49knu8D1QU+knkVAhvJLJ8k2QX4QmZ5JsmDgGuS7AQ8AvuZ5zW5rQT2Emkb7XVQo7XRNE0doKx9FUQQnJTp3A3wDTcxdYvVw/Rm3AAAAAElFTkSuQmCC'
    );
      tray = new Tray(icon);
    if (!tray.isDestroyed()) {
      tray.setToolTip('Clicky');
      tray.on('click', () => console.log('[clicky:tray] tray clicked; app is push-to-talk triggered'));
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
      { label: 'Start Recording', click: openRecorderOrb },
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

function createOrbWindow(): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const width = 80;
  const height = 40;
  const offset = 15;

  let x = cursor.x + offset;
  let y = cursor.y + offset;

  const bounds = display.workArea;
  x = Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width));
  y = Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height));

  console.log('[clicky:orb] creating orb window', {
    cursor,
    display: display.id,
    x,
    y,
    width,
    height
  });

  const win = new BrowserWindow({
    width,
    height,
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
      win.setIgnoreMouseEvents(true);
      recorderWindowReady = true;
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
    windowContexts.delete(winId);
    recorderWindow = undefined;
    recorderWindowReady = false;
    console.log('[clicky:orb] window closed and context removed', { winId });
  });
}

function createAgentWindow(agentId: string): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { miniWidth: width, miniHeight: height, margin, stackGap } = agentWindowMetrics;
  const x = primary.workArea.x + primary.workArea.width - width - margin;
  const y = primary.workArea.y + margin + (agents.size * (height + stackGap));
  console.log('[clicky:agent] creating agent window', { agentId, x, y, width, height });

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

async function scrapeWebsiteContent(url: string): Promise<string> {
  console.log('[clicky:scrape] fetching', { url });
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  console.log('[clicky:scrape] fetched', { url, bytes: html.length });

  // Remove script, style, noscript, iframe tags and their contents
  let text = html
    .replace(/<(script|style|noscript|iframe|nav|footer|header|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, (match) => {
      try {
        return String.fromCharCode(parseInt(match.slice(2, -1), 10));
      } catch {
        return match;
      }
    })
    .replace(/\s+/g, ' ')
    .trim();

  const maxChars = 8000;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + '\n\n[Content truncated]';
  }
  console.log('[clicky:scrape] extracted text', { url, chars: text.length });
  return text;
}

function registerPushToTalkShortcut(): void {
  const shortcut = process.env.CLICKY_HOTKEY ?? 'Control+Alt+Space';
  const registered = globalShortcut.register(shortcut, () => {
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      if (recorderWindowReady) {
        safeSend(recorderWindow, ipcChannels.recordingStop);
        console.log('[clicky:hotkey] stop recording sent to orb');
      }
    } else {
      openRecorderOrb();
    }
  });

  if (registered) {
    console.log('[clicky:hotkey] global shortcut registered', { shortcut });
  } else {
    console.error('[clicky:hotkey] failed to register global shortcut', { shortcut });
  }
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
    } else if (event.type === 'tool_call' && event.name === 'check_email') {
      console.log('[clicky:agent] TOOL_CALL check_email RECEIVED', { agentId, args: event.arguments });
      let args: { count?: number } = {};
      try {
        args = event.arguments ? JSON.parse(event.arguments) as { count?: number } : {};
      } catch {
        args = {};
      }
      const count = Math.min(Math.max(args.count ?? 5, 1), 10);
      console.log('[clicky:agent] checking emails', { agentId, count, emailSettings: JSON.stringify(settings.email) });
      safeSend(win, ipcChannels.agentCommandFlash, 'Checking emails...');

      try {
        const { fetchRecentEmails } = await import('./emailService');
        const emailConfig = settings.email ?? { enabled: false, provider: 'gmail', username: '', password: '' };
        console.log('[clicky:agent] email config resolved', { enabled: emailConfig.enabled, username: emailConfig.username, hasPassword: !!emailConfig.password });
        const emails = await fetchRecentEmails(emailConfig, count);
        const emailSummary = emails.length === 0
          ? 'No emails found in your inbox.'
          : emails.map((e, i) => `${i + 1}. From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\nPreview: ${e.preview}`).join('\n\n');

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
      console.log('[clicky:agent] TOOL_CALL scrape_website RECEIVED', { agentId, args: event.arguments });
      let args: { url?: string } = {};
      try {
        args = event.arguments ? JSON.parse(event.arguments) as { url?: string } : {};
      } catch {
        args = {};
      }
      const url = args.url;
      if (url) {
        safeSend(win, ipcChannels.agentCommandFlash, `Scraping ${url}...`);
        try {
          const scrapedText = await scrapeWebsiteContent(url);
          console.log('[clicky:agent] website scraped successfully', { agentId, url });
          const toolResultRequest: VoiceTurnRequest = {
            transcript: `Here is the content from ${url}:\n\n${scrapedText}`,
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
    } else if (event.type === 'done') {
      state.status = 'done';
      state.response = fullResponse;
      state.summary = fullResponse.slice(0, 200) + (fullResponse.length > 200 ? '...' : '');
      state.completedAt = Date.now();
      state.actions = buildDefaultActions(request.transcript);
      state.conversationHistory = [
        ...request.conversationHistory,
        { role: 'user', content: request.transcript },
        { role: 'assistant', content: fullResponse }
      ];
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

  agents.set(agentId, { window: win, state, expanded: false });
  console.log('[clicky:agent] state stored', { agentId });

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

ipcMain.handle(ipcChannels.agentSetExpanded, (_event, agentId: string, expanded: boolean) => {
  setAgentWindowExpanded(agentId, expanded);
});

ipcMain.handle(ipcChannels.openUrl, async (_event, url: string) => {
  console.log('[clicky:main] openUrl invoked', { url });
  await shell.openExternal(url);
});

ipcMain.handle(ipcChannels.scrapeWebsite, async (_event, url: string): Promise<string> => {
  console.log('[clicky:main] scrapeWebsite invoked', { url });
  return scrapeWebsiteContent(url);
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
  globalShortcut.unregisterAll();
  console.log('[clicky:hotkey] global shortcuts unregistered');
});
app.on('window-all-closed', () => {
  void 0;
});
