import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchE2EApp, startRecordingFlow } from './fixtures';

type Scenario = 'email' | 'declutter' | 'website' | 'generic';

type AgentSnapshot = {
  status?: string;
  response?: string;
  displayHeader?: string;
  displayCaption?: string;
  summary?: string;
  commands?: string[];
};

const DEFAULT_TRANSCRIPTS: Record<Scenario, string> = {
  email: 'Check my last email and tell me what it is about.',
  declutter: 'My home screen is cluttered. Move the Excel, Word, and PDF files from my Desktop to trash.',
  website: 'Create a simple stopwatch website and open it.',
  generic: 'What can you help me with?'
};

test.describe('Clicky realtime flow smoke', () => {
  test.skip(
    process.env.CLICKY_REAL_E2E !== '1',
    'Skipped: set CLICKY_REAL_E2E=1 to run real realtime flow smoke test'
  );

  test.skip(!process.env.OPENAI_API_KEY, 'Skipped: OPENAI_API_KEY not set');

  test('mocked voice transcript runs through real realtime/tools flow', async () => {
    const scenario = normalizeScenario(process.env.CLICKY_E2E_SCENARIO);
    const transcript = process.env.CLICKY_E2E_TRANSCRIPT || DEFAULT_TRANSCRIPTS[scenario];
    const { electronApp, mainWindow, teardown } = await launchE2EApp();
    const snapshots: AgentSnapshot[] = [];

    try {
      const agentWindowPromise = waitForAgentPage(electronApp, 30_000);
      await startRecordingFlow(mainWindow, transcript);
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

      await waitForScenarioProgress(agentPage, scenario);

      await agentPage.waitForFunction(
        () => {
          const pill = document.querySelector('.status-pill');
          return pill?.classList.contains('done') || pill?.classList.contains('error');
        },
        { timeout: 120_000 }
      );

      const finalState = await agentPage.evaluate(() => {
        const pill = document.querySelector('.status-pill');
        const text = document.body.textContent ?? '';
        return { pillClass: pill?.className ?? '', text };
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

      expect(finalState.pillClass).toContain('done');
      // Wait for WebRTC audio to finish playing (UI done ≠ audio done)
      await agentPage.waitForTimeout(5000);
      expect(finalState.text).not.toMatch(/can(?:not|'t)\s+(?:access|check|control|move|create|open)/i);

      if (scenario === 'email') {
        expect(allText).toMatch(/checking.*email/i);
      }
      if (scenario === 'declutter') {
        expect(allText).toMatch(/moving.*files.*trash|cleaning desktop|moved to trash/i);
      }
      if (scenario === 'website') {
        expect(allText).toMatch(/write|open|created|website|app|\/tmp\/clicky_apps/i);
      }
    } finally {
      await teardown();
    }
  });
});

function normalizeScenario(value: string | undefined): Scenario {
  if (value === 'email' || value === 'declutter' || value === 'website') return value;
  return 'generic';
}

async function waitForScenarioProgress(page: Page, scenario: Scenario): Promise<void> {
  if (scenario === 'generic') return;
  const patterns: Record<Exclude<Scenario, 'generic'>, RegExp> = {
    email: /checking.*email/i,
    declutter: /mov(?:ing|ed).*files.*trash|cleaning desktop/i,
    website: /writing|opening|website|app|running/i
  };
  await page.waitForFunction(
    (source) => new RegExp(source, 'i').test(document.body.textContent ?? ''),
    patterns[scenario].source,
    { timeout: 60_000 }
  );
}

async function waitForAgentPage(electronApp: ElectronApplication, timeoutMs: number): Promise<Page> {
  for (const page of electronApp.windows()) {
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
