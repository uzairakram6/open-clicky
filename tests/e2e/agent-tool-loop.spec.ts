import { test, expect } from '@playwright/test';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launchE2EApp } from './fixtures';

test.describe('Open Clicky structured tool loop', () => {
  test('repairs through a real tool result instead of fake user recursion', async () => {
    const filePath = '/tmp/clicky-e2e-read-file.txt';
    await writeFile(filePath, 'Azar wants a minimal coffee shop landing page app.', 'utf8');

    const { mainWindow, teardown } = await launchE2EApp();
    try {
      const agentId = await mainWindow.evaluate(async (path) => {
        const w = window as unknown as {
          clicky?: {
            spawnAgent: (request: {
              transcript: string;
              captures: unknown[];
              model: string;
              conversationHistory: unknown[];
            }) => Promise<string>;
          };
        };
        if (!w.clicky) throw new Error('Open Clicky preload API missing');
        return w.clicky.spawnAgent({
          transcript: `Read ${path} and tell me what Azar wants built.`,
          captures: [],
          model: 'gpt-5.4-mini',
          conversationHistory: []
        });
      }, filePath);

      const state = await mainWindow.evaluate(async (id) => {
        const w = window as unknown as {
          clicky?: { getAgentState: (agentId: string) => Promise<{ status?: string; response?: string; commands?: string[] } | undefined> };
        };
        return w.clicky?.getAgentState(id);
      }, agentId);

      expect(state?.status).toBe('done');
      expect(state?.commands?.join('\n')).toContain('Reading file...');
      expect(state?.response).toMatch(/coffee\s*shop\s*landing\s*page/i);
    } finally {
      await teardown();
    }
  });

  test('builds a website when write_file arguments are empty and opens it', async () => {
    const { mainWindow, teardown } = await launchE2EApp();
    try {
      const agentId = await mainWindow.evaluate(async () => {
        const w = window as unknown as {
          clicky?: {
            spawnAgent: (request: {
              transcript: string;
              captures: unknown[];
              model: string;
              conversationHistory: unknown[];
            }) => Promise<string>;
          };
        };
        if (!w.clicky) throw new Error('Open Clicky preload API missing');
        return w.clicky.spawnAgent({
          transcript: 'Build a coffee shop landing page website and open it in a chrome tab.',
          captures: [],
          model: 'gpt-5.4-mini',
          conversationHistory: []
        });
      });

      const state = await mainWindow.evaluate(async (id) => {
        const w = window as unknown as {
          clicky?: {
            getAgentState: (agentId: string) => Promise<{
              status?: string;
              response?: string;
              commands?: string[];
              generatedAppPath?: string;
            } | undefined>;
          };
        };
        return w.clicky?.getAgentState(id);
      }, agentId);

      expect(state?.status).toBe('done');
      expect(state?.generatedAppPath).toMatch(/^\/tmp\/clicky_apps\/.+\/index\.html$/);
      expect(state?.commands?.join('\n')).toContain('Creating local files...');
      const html = await readFile(state?.generatedAppPath ?? '', 'utf8');
      expect(html).toContain('Coffee Shop Landing Page');
      expect(html).toContain('<!doctype html>');
      expect(state?.response).toMatch(/built|opened|browser/i);
    } finally {
      await teardown();
    }
  });

  test('turns current context into a website when write_file arguments are empty', async () => {
    const { mainWindow, teardown } = await launchE2EApp();
    try {
      const agentId = await mainWindow.evaluate(async () => {
        const w = window as unknown as {
          clicky?: {
            spawnAgent: (request: {
              transcript: string;
              captures: unknown[];
              model: string;
              conversationHistory: unknown[];
            }) => Promise<string>;
          };
        };
        if (!w.clicky) throw new Error('Open Clicky preload API missing');
        return w.clicky.spawnAgent({
          transcript: 'Turn into a website and open it up in a chrome tab',
          captures: [],
          model: 'gpt-5.4-mini',
          conversationHistory: [
            { role: 'user', content: 'What is the document asking for?' },
            { role: 'assistant', content: 'Build a minimal landing page for a coffee shop landing page app.' }
          ]
        });
      });

      const state = await mainWindow.evaluate(async (id) => {
        const w = window as unknown as {
          clicky?: {
            getAgentState: (agentId: string) => Promise<{
              status?: string;
              response?: string;
              commands?: string[];
              generatedAppPath?: string;
            } | undefined>;
          };
        };
        return w.clicky?.getAgentState(id);
      }, agentId);

      expect(state?.status).toBe('done');
      expect(state?.generatedAppPath).toMatch(/^\/tmp\/clicky_apps\/.+\/index\.html$/);
      expect(state?.commands?.join('\n')).toContain('Creating local files...');
      const html = await readFile(state?.generatedAppPath ?? '', 'utf8');
      expect(html).toContain('<!doctype html>');
      expect(state?.response).toMatch(/built|opened|browser/i);
    } finally {
      await teardown();
    }
  });

  test('finishes locally after a successful side-effect-only open_file tool', async () => {
    const filePath = '/tmp/clicky-e2e-open-file.txt';
    await writeFile(filePath, 'Open me without a second model round trip.', 'utf8');

    const { mainWindow, teardown } = await launchE2EApp();
    try {
      const agentId = await mainWindow.evaluate(async (path) => {
        const w = window as unknown as {
          clicky?: {
            spawnAgent: (request: {
              transcript: string;
              captures: unknown[];
              model: string;
              conversationHistory: unknown[];
            }) => Promise<string>;
          };
        };
        if (!w.clicky) throw new Error('Open Clicky preload API missing');
        return w.clicky.spawnAgent({
          transcript: `Open ${path}`,
          captures: [],
          model: 'gpt-5.4-mini',
          conversationHistory: []
        });
      }, filePath);

      const state = await mainWindow.evaluate(async (id) => {
        const w = window as unknown as {
          clicky?: {
            getAgentState: (agentId: string) => Promise<{
              status?: string;
              response?: string;
              commands?: string[];
            } | undefined>;
          };
        };
        return w.clicky?.getAgentState(id);
      }, agentId);

      expect(state?.status).toBe('done');
      expect(state?.commands?.join('\n')).toContain('Opening file...');
      expect(state?.response).toBe('Opened it.');
    } finally {
      await teardown();
    }
  });

  test('finishes locally after a successful terminal shell side effect', async () => {
    const dirPath = '/tmp/clicky-e2e-terminal-action';
    await rm(dirPath, { recursive: true, force: true });

    const { mainWindow, teardown } = await launchE2EApp();
    try {
      const agentId = await mainWindow.evaluate(async (path) => {
        const w = window as unknown as {
          clicky?: {
            spawnAgent: (request: {
              transcript: string;
              captures: unknown[];
              model: string;
              conversationHistory: unknown[];
            }) => Promise<string>;
          };
        };
        if (!w.clicky) throw new Error('Open Clicky preload API missing');
        return w.clicky.spawnAgent({
          transcript: `Create ${path} and tell me when it is done.`,
          captures: [],
          model: 'gpt-5.4-mini',
          conversationHistory: []
        });
      }, dirPath);

      const state = await mainWindow.evaluate(async (id) => {
        const w = window as unknown as {
          clicky?: {
            getAgentState: (agentId: string) => Promise<{
              status?: string;
              response?: string;
              commands?: string[];
            } | undefined>;
          };
        };
        return w.clicky?.getAgentState(id);
      }, agentId);

      const dir = await stat(dirPath);
      const commandLabels = state?.commands?.filter((command) => command === 'Updating local files...') ?? [];

      expect(dir.isDirectory()).toBe(true);
      expect(state?.status).toBe('done');
      expect(state?.response).toBe('Done. Created /tmp/clicky-e2e-terminal-action.');
      expect(commandLabels).toHaveLength(1);
      const logText = await readAgentRunLog(agentId);
      expect(logText).toContain('"type":"tts_stop"');
      expect(logText).toContain('"reason":"local-tool-execute_bash_command"');
    } finally {
      await teardown();
      await rm(dirPath, { recursive: true, force: true });
    }
  });
});

async function readAgentRunLog(agentId: string): Promise<string> {
  const dir = join(homedir(), '.config', 'Electron', 'agent-runs');
  const files = await readdir(dir);
  const logFile = files.find((file) => file === `${agentId}.jsonl`);
  if (!logFile) throw new Error(`Agent log not found for ${agentId}`);
  return readFile(join(dir, logFile), 'utf8');
}
