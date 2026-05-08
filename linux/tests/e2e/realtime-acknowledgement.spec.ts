import { test, expect } from '@playwright/test';
import { ElectronApplication, Page } from '@playwright/test';
import { launchE2EApp, startRecordingFlow } from './fixtures';

type AgentSnapshot = {
  status?: string;
  response?: string;
  displayHeader?: string;
  displayCaption?: string;
  summary?: string;
  commands?: string[];
};

test.describe('Clicky realtime acknowledgement flow', () => {
  test.skip(
    process.env.CLICKY_REAL_E2E !== '1',
    'Skipped: set CLICKY_REAL_E2E=1 to run real realtime acknowledgement smoke test'
  );

  test.skip(!process.env.OPENAI_API_KEY, 'Skipped: OPENAI_API_KEY not set');

  test('mocked voice transcript uses real realtime/tools and acknowledges email before final answer', async () => {
    const { electronApp, mainWindow, teardown } = await launchE2EApp();
    const snapshots: AgentSnapshot[] = [];

    try {
      const agentWindowPromise = waitForAgentPage(electronApp, 30_000);
      await startRecordingFlow(mainWindow, 'Check my last email and tell me what it is about.');
      const agentPage = await agentWindowPromise;

      await agentPage.exposeFunction('e2eCaptureAgentState', (json: string) => {
        snapshots.push(JSON.parse(json) as AgentSnapshot);
      });

      await agentPage.evaluate(() => {
        const w = window as unknown as {
          clicky?: { onAgentUpdate: (cb: (state: unknown) => void) => () => void };
          e2eCaptureAgentState?: (json: string) => void;
        };
        w.clicky?.onAgentUpdate((state) => {
          w.e2eCaptureAgentState?.(JSON.stringify(state));
        });
      });

      await agentPage.waitForFunction(
        () => {
          const text = document.body.textContent ?? '';
          return /checking.*email/i.test(text);
        },
        { timeout: 45_000 }
      );

      await agentPage.waitForFunction(
        () => {
          const pill = document.querySelector('.status-pill');
          return pill?.classList.contains('done') || pill?.classList.contains('error');
        },
        { timeout: 90_000 }
      );

      const finalState = await agentPage.evaluate(() => {
        const pill = document.querySelector('.status-pill');
        const text = document.body.textContent ?? '';
        return {
          pillClass: pill?.className ?? '',
          text
        };
      });

      const allText = snapshots
        .flatMap((snapshot) => [
          snapshot.displayHeader,
          snapshot.displayCaption,
          snapshot.summary,
          snapshot.response,
          ...(snapshot.commands ?? [])
        ])
        .filter(Boolean)
        .join('\n');

      expect(allText).toMatch(/checking.*email/i);
      expect(allText).not.toMatch(/can(?:not|'t)\s+(?:access|check).*email/i);
      expect(finalState.pillClass).toContain('done');
      expect(finalState.text).not.toMatch(/can(?:not|'t)\s+(?:access|check).*email/i);
    } finally {
      await teardown();
    }
  });
});

async function waitForAgentPage(electronApp: ElectronApplication, timeoutMs: number): Promise<Page> {
  const existing = electronApp.windows();
  for (const page of existing) {
    if (await isAgentPage(page)) return page;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      electronApp.off('window', onWindow);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for agent page`));
    }, timeoutMs);

    const onWindow = (page: Page) => {
      void (async () => {
        if (!(await isAgentPage(page))) return;
        clearTimeout(timeout);
        electronApp.off('window', onWindow);
        resolve(page);
      })();
    };

    electronApp.on('window', onWindow);
  });
}

async function isAgentPage(page: Page): Promise<boolean> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
    const context = await page.evaluate(async () => {
      const w = window as unknown as {
        clicky?: { getWindowContext: () => Promise<{ type?: string } | undefined> };
      };
      return w.clicky?.getWindowContext();
    });
    return context?.type === 'agent';
  } catch {
    return false;
  }
}
