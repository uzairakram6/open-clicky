import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

interface E2EFixture {
  electronApp: ElectronApplication;
  mainWindow: Page;
  teardown: () => Promise<void>;
}

export async function launchE2EApp(): Promise<E2EFixture> {
  const electronApp = await electron.launch({
    cwd: PROJECT_ROOT,
    args: [join(PROJECT_ROOT, 'dist/main/main.js')],
    env: {
      ...process.env,
      CLICKY_E2E: '1',
      NODE_ENV: 'test'
    }
  });

  electronApp.process().stdout?.on('data', (data) => {
    console.log('[E2E:stdout]', data.toString().trim());
  });
  electronApp.process().stderr?.on('data', (data) => {
    console.log('[E2E:stderr]', data.toString().trim());
  });

  let pageError = '';
  electronApp.on('window', async (page) => {
    console.log('[E2E] Window opened');
    page.on('pageerror', (err) => {
      pageError = err.message;
      console.error('[E2E:pageerror]', err.message);
    });
    page.on('console', (msg) => {
      console.log(`[E2E:console:${msg.type()}]`, msg.text());
    });
    page.on('crash', () => console.error('[E2E] PAGE CRASHED'));
  });

  const mainWindow = await electronApp.firstWindow();

  return {
    electronApp,
    mainWindow,
    teardown: async () => {
      await electronApp.close();
    }
  };
}

export async function startRecordingFlow(
  mainWindow: Page,
  transcript: string
): Promise<void> {
  await mainWindow.evaluate(
    async (text) => {
      const w = window as unknown as {
        clicky?: {
          e2e: { startRecordingFlow: (t: string) => Promise<void> };
        };
      };
      if (!w.clicky?.e2e) {
        throw new Error('E2E API not available on window.clicky.e2e');
      }
      await w.clicky.e2e.startRecordingFlow(text);
    },
    transcript
  );
}

export async function getAgentStates(
  mainWindow: Page
): Promise<Record<string, unknown>> {
  return mainWindow.evaluate(async () => {
    const w = window as unknown as {
      clicky?: {
        e2e: { getAgentStates: () => Promise<Record<string, unknown>> };
      };
    };
    if (!w.clicky?.e2e) {
      throw new Error('E2E API not available');
    }
    return w.clicky.e2e.getAgentStates();
  });
}

export async function waitForAgentWindow(
  electronApp: ElectronApplication,
  timeoutMs = 20_000
): Promise<Page> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for agent window`));
    }, timeoutMs);

    const onWindow = (page: Page) => {
      clearTimeout(timeout);
      resolve(page);
    };

    electronApp.on('window', onWindow);
  });
}

export interface EmailSummary {
  from: string;
  subject: string;
  date: string;
  preview: string;
  attachments: string[];
  uid: number;
}
