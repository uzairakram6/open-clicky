import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { launchE2EApp } from './fixtures';

const execFileAsync = promisify(execFile);

type AgentStateSnapshot = {
  status?: string;
  response?: string;
  commands?: string[];
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
  generatedAppPath?: string;
};

test.describe('Open Clicky Word document website flow', () => {
  test.skip(
    process.env.CLICKY_REAL_E2E !== '1',
    'Skipped: set CLICKY_REAL_E2E=1 to run real OpenAI/tool flow'
  );
  test.skip(!process.env.OPENAI_API_KEY, 'Skipped: OPENAI_API_KEY not set');

  test('reads a Word document, builds a website from it, and opens it in Chrome', async () => {
    const docxPath = await createCoffeeShopDocx();
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
          transcript: `Read this Word document and tell me what landing page it describes: ${path}`,
          captures: [],
          model: 'gpt-5.4-mini',
          conversationHistory: []
        });
      }, docxPath);

      const readState = await getAgentState(mainWindow, agentId);
      expect(readState?.status).toBe('done');
      expect(readState?.response ?? '').toMatch(/coffee|cafe|landing page|espresso/i);
      expect(readState?.commands?.join('\n') ?? '').toMatch(/Reading file/i);

      await mainWindow.evaluate(async ({ id, state }) => {
        const w = window as unknown as {
          clicky?: {
            followUp: (agentId: string, request: {
              transcript: string;
              captures: unknown[];
              model: string;
              conversationHistory: unknown[];
              agentId: string;
            }) => Promise<void>;
          };
        };
        if (!w.clicky) throw new Error('Open Clicky preload API missing');
        await w.clicky.followUp(id, {
          transcript: 'Build that into a website and open it in a Chrome tab.',
          captures: [],
          model: state.model ?? 'gpt-5.4-mini',
          conversationHistory: state.conversationHistory ?? [],
          agentId: id
        });
      }, { id: agentId, state: readState });

      const buildState = await getAgentState(mainWindow, agentId);
      expect(buildState?.status).toBe('done');
      expect(buildState?.generatedAppPath).toMatch(/^\/tmp\/clicky_apps\/.+\/index\.html$/);
      expect(buildState?.response ?? '').toMatch(/built|opened|browser|tab|website/i);
      expect(buildState?.commands?.join('\n') ?? '').toMatch(/Creating local files|Opening generated website in browser/i);

      const html = await readFile(buildState?.generatedAppPath ?? '', 'utf8');
      expect(html).toContain('<!doctype html>');
      expect(html).toMatch(/coffee|cafe|espresso|subscription/i);

      const logText = await readAgentRunLog(process.env.HOME ?? '', agentId);
      expect(countMatches(logText, '"type":"tts_audio_sent"')).toBe(1);
      expect(logText).toContain('"type":"tts_skipped_stale"');
      expect(logText).toContain('"source":"auto_open_generated_app"');
      expect(logText).toContain('google-chrome --new-tab');
    } finally {
      await teardown();
    }
  });
});

async function getAgentState(page: { evaluate: <T, A>(fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T> }, agentId: string): Promise<AgentStateSnapshot | undefined> {
  return page.evaluate(async (id) => {
    const w = window as unknown as {
      clicky?: { getAgentState: (agentId: string) => Promise<AgentStateSnapshot | undefined> };
    };
    return w.clicky?.getAgentState(id);
  }, agentId);
}

async function readAgentRunLog(home: string, agentId: string): Promise<string> {
  const dir = join(home, '.config', 'Electron', 'agent-runs');
  const files = await readdir(dir);
  const logFile = files.find((file) => file === `${agentId}.jsonl`);
  if (!logFile) throw new Error(`Agent log not found for ${agentId}`);
  return readFile(join(dir, logFile), 'utf8');
}

function countMatches(text: string, pattern: string): number {
  return text.split(pattern).length - 1;
}

async function createCoffeeShopDocx(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clicky-docx-'));
  const docxRoot = join(root, 'docx');
  await mkdir(join(docxRoot, '_rels'), { recursive: true });
  await mkdir(join(docxRoot, 'word', '_rels'), { recursive: true });

  await writeFile(join(docxRoot, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, 'utf8');
  await writeFile(join(docxRoot, '_rels', '.rels'), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8');
  await writeFile(join(docxRoot, 'word', '_rels', 'document.xml.rels'), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`, 'utf8');
  await writeFile(join(docxRoot, 'word', 'document.xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Coffee shop landing page request</w:t></w:r></w:p>
    <w:p><w:r><w:t>Create a polished one-page website for Ember &amp; Bean, a neighborhood coffee shop.</w:t></w:r></w:p>
    <w:p><w:r><w:t>The page should feature espresso drinks, fresh pastries, subscription beans, opening hours, and a warm call to action.</w:t></w:r></w:p>
  </w:body>
</w:document>`, 'utf8');

  const docxPath = join(root, 'coffee-shop-landing-page.docx');
  await execFileAsync('zip', ['-qr', docxPath, '.'], { cwd: docxRoot });
  return docxPath;
}
