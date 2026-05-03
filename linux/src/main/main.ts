import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, session, Tray } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from './settings';
import { WorkerApi } from './workerApi';
import { ipcChannels } from '../shared/ipcChannels';
import type { AppSettings, CaptureSource, VoiceTurnRequest } from '../shared/types';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
let panel: BrowserWindow | undefined;
let tray: Tray | undefined;
let settings: AppSettings;

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on('second-instance', showPanel);

async function createPanel(): Promise<void> {
  settings = await loadSettings();

  panel = new BrowserWindow({
    width: 420,
    height: 680,
    show: false,
    resizable: true,
    title: 'Clicky',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } }).then((sources) => {
      const source = sources.find((item) => item.id === settings.selectedCaptureSourceId) ?? sources[0];
      callback(source ? { video: source, audio: 'loopback' } : {});
    });
  }, { useSystemPicker: true });

  if (process.env.VITE_DEV_SERVER_URL) {
    await panel.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await panel.loadFile(join(__dirname, '../renderer/index.html'));
  }

  createTray();
  registerShortcut(settings.shortcut);
  showPanel();
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAxklEQVR4nJ2TsQ3CMAxF3w0wARsQG7ACG7ABG7ABG7ABG7ABG7ABG7ABG1AQEmioUqRKkZzYTvb9+66fYAIz6wVcAE6Bm8A84GgAdwUTYAG8Avc8y0bB3wJNgcZJY1MFXgP7GNcAUWAvkU2bmQEcA49knu8D1QU+knkVAhvJLJ8k2QX4QmZ5JsmDgGuS7AQ8AvuZ5zW5rQT2Emkb7XVQo7XRNE0doKx9FUQQnJTp3A3wDTcxdYvVw/Rm3AAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  tray.setToolTip('Clicky');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: showPanel },
    { label: 'Start/Stop Recording', click: toggleRecording },
    { type: 'separator' },
    { label: 'Settings', click: showPanel },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', showPanel);
}

function showPanel(): void {
  panel?.show();
  panel?.focus();
}

function toggleRecording(): void {
  panel?.webContents.send(ipcChannels.voiceToggle);
}

function registerShortcut(shortcut: string): void {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(shortcut, toggleRecording);
  if (!ok) {
    panel?.webContents.send(ipcChannels.chatError, 'Unable to register global shortcut');
  }
}

ipcMain.handle(ipcChannels.settingsGet, () => settings);
ipcMain.handle(ipcChannels.settingsSet, async (_event, next: AppSettings) => {
  settings = await saveSettings(next);
  registerShortcut(settings.shortcut);
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

ipcMain.handle(ipcChannels.chatSendTurn, async (_event, request: VoiceTurnRequest) => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  try {
    for await (const event of api.sendTurn(request)) {
      panel?.webContents.send(`chat:${event.type}`, event.text ?? event.error ?? '');
    }
  } catch (error) {
    panel?.webContents.send(ipcChannels.chatError, error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle(ipcChannels.transcribeGetToken, async () => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  return api.getTranscribeToken();
});

ipcMain.handle(ipcChannels.ttsSpeak, async (_event, text: string) => {
  const api = new WorkerApi({ workerBaseUrl: settings.workerBaseUrl });
  try {
    const audio = await api.synthesizeSpeech(text);
    panel?.webContents.send(ipcChannels.ttsAudio, audio);
  } catch (error) {
    panel?.webContents.send(ipcChannels.ttsError, error instanceof Error ? error.message : String(error));
  }
});

app.whenReady().then(createPanel);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  // Keep the tray app alive until the user chooses Quit.
});
