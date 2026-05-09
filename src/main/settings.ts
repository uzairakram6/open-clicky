import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppSettings } from '../shared/types';

const defaults: AppSettings = {
  workerBaseUrl: 'http://127.0.0.1:8787',
  model: 'gpt-5.4-mini',
  onboarded: false,
  email: {
    enabled: false,
    provider: 'gmail',
    username: '',
    password: ''
  }
};

export async function loadSettings(): Promise<AppSettings> {
  const path = settingsPath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...defaults, ...parsed };
    console.log('[clicky:settings] loaded from', path, 'email:', summarizeEmailConfig(merged.email));
    return merged;
  } catch (err) {
    console.error('[clicky:settings] failed to load from', path, 'error:', err);
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
    onboarded: settings.onboarded,
    email: settings.email
      ? {
          ...settings.email,
          password: ''
        }
      : undefined
  };
  await writeFile(settingsPath(), JSON.stringify(sanitized, null, 2));
  return sanitized;
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
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
