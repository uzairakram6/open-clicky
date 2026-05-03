import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings } from '../shared/types';

const defaults: AppSettings = {
  workerBaseUrl: 'http://127.0.0.1:8787',
  model: 'gpt-5.4-mini',
  onboarded: false
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  await mkdir(app.getPath('userData'), { recursive: true });
    const sanitized: AppSettings = {
      workerBaseUrl: settings.workerBaseUrl,
      model: settings.model,
      selectedCaptureSourceId: settings.selectedCaptureSourceId,
      selectedCaptureSourceLabel: settings.selectedCaptureSourceLabel,
      onboarded: settings.onboarded
  };
  await writeFile(settingsPath(), JSON.stringify(sanitized, null, 2));
  return sanitized;
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}
