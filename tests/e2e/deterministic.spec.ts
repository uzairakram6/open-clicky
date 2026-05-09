import { test, expect } from '@playwright/test';
import { launchE2EApp, startRecordingFlow, waitForAgentWindow } from './fixtures';

function log(msg: string) {
  process.stdout.write('[E2E:test] ' + msg + '\n');
}

test.describe('Open Clicky E2E — "Check my emails" real flow', () => {
  test('full pipeline: orb → transcript → agent → OpenAI → IMAP → response', async () => {
    const { electronApp, mainWindow, teardown } = await launchE2EApp();
    const agentStates: Array<Record<string, unknown>> = [];

    try {
      await startRecordingFlow(mainWindow, 'Check my emails');
      const agentPage = await waitForAgentWindow(electronApp, 30_000);

      await agentPage.exposeFunction('e2eLogAgentState', (stateJson: string) => {
        try {
          const s = JSON.parse(stateJson);
          agentStates.push(s);
          log('STATE status=' + s.status +
            ' response="' + ((s.response as string) || '').slice(0, 200) + '"' +
            ' caption="' + ((s.displayCaption as string) || '').slice(0, 120) + '"' +
            ' commands=' + JSON.stringify(s.commands));
        } catch { void 0; }
      });

      await agentPage.evaluate(() => {
        const w = window as unknown as {
          clicky?: { onAgentUpdate: (cb: (s: unknown) => void) => () => void };
          e2eLogAgentState?: (json: string) => void;
        };
        w.clicky?.onAgentUpdate((s: unknown) => {
          w.e2eLogAgentState?.(JSON.stringify(s));
        });
      });

      await agentPage.waitForSelector('.agent-widget', { timeout: 10_000 });

      await agentPage.waitForFunction(
        () => {
          const pill = document.querySelector('.status-pill');
          if (!pill) return false;
          return pill.classList.contains('done') || pill.classList.contains('error');
        },
        { timeout: 60_000 }
      ).catch(() => log('TIMEOUT waiting for done/error status'));

      const finalUI = await agentPage.evaluate(() => {
        const pill = document.querySelector('.status-pill');
        const lead = document.querySelector('.agent-modal-lead');
        const commands = Array.from(document.querySelectorAll('.terminal-box .terminal-text'))
          .map((el) => el.textContent);
        const errorBadge = document.querySelector('.error-badge');
        return {
          pillClass: pill?.className || 'none',
          leadText: lead?.textContent || 'none',
          commands,
          errorText: errorBadge?.textContent || 'none'
        };
      });

      log('=== FINAL UI STATE ===');
      log('pill: ' + finalUI.pillClass);
      log('lead: "' + finalUI.leadText + '"');
      log('commands: ' + JSON.stringify(finalUI.commands));
      log('error: ' + finalUI.errorText);

      log('=== ALL AGENT RESPONSES ===');
      for (const s of agentStates) {
        if (s.response) {
          log('RESPONSE: ' + s.response);
        }
      }

      const isDone = finalUI.pillClass.includes('done');
      const isError = finalUI.pillClass.includes('error');
      expect(isDone || isError).toBe(true);

      const hasEmailCommand = finalUI.commands.some(
        (c) => c && /checking.email|email/i.test(c)
      );
      log('hasEmailCommand: ' + hasEmailCommand);
      expect(hasEmailCommand).toBe(true);

      if (isDone) {
        expect(finalUI.leadText.length).toBeGreaterThan(10);
      }

    } finally {
      await teardown();
    }
  });
});
