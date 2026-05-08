# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: realtime-flow.spec.ts >> Clicky realtime flow smoke >> mocked voice transcript runs through real realtime/tools flow
- Location: tests/e2e/realtime-flow.spec.ts:30:3

# Error details

```
Error: page.waitForFunction: Target page, context or browser has been closed
```

# Test source

```ts
  14  | 
  15  | const DEFAULT_TRANSCRIPTS: Record<Scenario, string> = {
  16  |   email: 'Check my last email and tell me what it is about.',
  17  |   declutter: 'My home screen is cluttered. Move the Excel, Word, and PDF files from my Desktop to trash.',
  18  |   website: 'Create a simple stopwatch website and open it.',
  19  |   generic: 'What can you help me with?'
  20  | };
  21  | 
  22  | test.describe('Clicky realtime flow smoke', () => {
  23  |   test.skip(
  24  |     process.env.CLICKY_REAL_E2E !== '1',
  25  |     'Skipped: set CLICKY_REAL_E2E=1 to run real realtime flow smoke test'
  26  |   );
  27  | 
  28  |   test.skip(!process.env.OPENAI_API_KEY, 'Skipped: OPENAI_API_KEY not set');
  29  | 
  30  |   test('mocked voice transcript runs through real realtime/tools flow', async () => {
  31  |     const scenario = normalizeScenario(process.env.CLICKY_E2E_SCENARIO);
  32  |     const transcript = process.env.CLICKY_E2E_TRANSCRIPT || DEFAULT_TRANSCRIPTS[scenario];
  33  |     const { electronApp, mainWindow, teardown } = await launchE2EApp();
  34  |     const snapshots: AgentSnapshot[] = [];
  35  | 
  36  |     try {
  37  |       const agentWindowPromise = waitForAgentPage(electronApp, 30_000);
  38  |       await startRecordingFlow(mainWindow, transcript);
  39  |       const agentPage = await agentWindowPromise;
  40  | 
  41  |       await agentPage.exposeFunction('e2eCaptureAgentState', (json: string) => {
  42  |         snapshots.push(JSON.parse(json) as AgentSnapshot);
  43  |       });
  44  | 
  45  |       await agentPage.evaluate(() => {
  46  |         const w = window as unknown as {
  47  |           clicky?: { onAgentUpdate: (cb: (state: unknown) => void) => () => void };
  48  |           e2eCaptureAgentState?: (json: string) => void;
  49  |         };
  50  |         w.clicky?.onAgentUpdate((state) => {
  51  |           w.e2eCaptureAgentState?.(JSON.stringify(state));
  52  |         });
  53  |       });
  54  | 
  55  |       await waitForScenarioProgress(agentPage, scenario);
  56  | 
  57  |       await agentPage.waitForFunction(
  58  |         () => {
  59  |           const pill = document.querySelector('.status-pill');
  60  |           return pill?.classList.contains('done') || pill?.classList.contains('error');
  61  |         },
  62  |         { timeout: 120_000 }
  63  |       );
  64  | 
  65  |       const finalState = await agentPage.evaluate(() => {
  66  |         const pill = document.querySelector('.status-pill');
  67  |         const text = document.body.textContent ?? '';
  68  |         return { pillClass: pill?.className ?? '', text };
  69  |       });
  70  | 
  71  |       const allText = snapshots
  72  |         .flatMap((snapshot) => [
  73  |           snapshot.displayHeader,
  74  |           snapshot.displayCaption,
  75  |           snapshot.summary,
  76  |           snapshot.response,
  77  |           ...(snapshot.commands ?? [])
  78  |         ])
  79  |         .filter(Boolean)
  80  |         .join('\n');
  81  | 
  82  |       expect(finalState.pillClass).toContain('done');
  83  |       // Wait for WebRTC audio to finish playing (UI done ≠ audio done)
  84  |       await agentPage.waitForTimeout(5000);
  85  |       expect(finalState.text).not.toMatch(/can(?:not|'t)\s+(?:access|check|control|move|create|open)/i);
  86  | 
  87  |       if (scenario === 'email') {
  88  |         expect(allText).toMatch(/checking.*email/i);
  89  |       }
  90  |       if (scenario === 'declutter') {
  91  |         expect(allText).toMatch(/moving.*files.*trash|cleaning desktop|moved to trash/i);
  92  |       }
  93  |       if (scenario === 'website') {
  94  |         expect(allText).toMatch(/write|open|created|website|app|\/tmp\/clicky_apps/i);
  95  |       }
  96  |     } finally {
  97  |       await teardown();
  98  |     }
  99  |   });
  100 | });
  101 | 
  102 | function normalizeScenario(value: string | undefined): Scenario {
  103 |   if (value === 'email' || value === 'declutter' || value === 'website') return value;
  104 |   return 'generic';
  105 | }
  106 | 
  107 | async function waitForScenarioProgress(page: Page, scenario: Scenario): Promise<void> {
  108 |   if (scenario === 'generic') return;
  109 |   const patterns: Record<Exclude<Scenario, 'generic'>, RegExp> = {
  110 |     email: /checking.*email/i,
  111 |     declutter: /moving.*files.*trash|cleaning desktop/i,
  112 |     website: /writing|opening|website|app|running/i
  113 |   };
> 114 |   await page.waitForFunction(
      |              ^ Error: page.waitForFunction: Target page, context or browser has been closed
  115 |     (source) => new RegExp(source, 'i').test(document.body.textContent ?? ''),
  116 |     patterns[scenario].source,
  117 |     { timeout: 60_000 }
  118 |   );
  119 | }
  120 | 
  121 | async function waitForAgentPage(electronApp: ElectronApplication, timeoutMs: number): Promise<Page> {
  122 |   for (const page of electronApp.windows()) {
  123 |     if (await isAgentPage(page)) return page;
  124 |   }
  125 | 
  126 |   return new Promise((resolve, reject) => {
  127 |     const timeout = setTimeout(() => {
  128 |       electronApp.off('window', onWindow);
  129 |       reject(new Error(`Timed out after ${timeoutMs}ms waiting for agent page`));
  130 |     }, timeoutMs);
  131 | 
  132 |     const onWindow = (page: Page) => {
  133 |       void (async () => {
  134 |         if (!(await isAgentPage(page))) return;
  135 |         clearTimeout(timeout);
  136 |         electronApp.off('window', onWindow);
  137 |         resolve(page);
  138 |       })();
  139 |     };
  140 | 
  141 |     electronApp.on('window', onWindow);
  142 |   });
  143 | }
  144 | 
  145 | async function isAgentPage(page: Page): Promise<boolean> {
  146 |   try {
  147 |     await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
  148 |     const context = await page.evaluate(async () => {
  149 |       const w = window as unknown as {
  150 |         clicky?: { getWindowContext: () => Promise<{ type?: string } | undefined> };
  151 |       };
  152 |       return w.clicky?.getWindowContext();
  153 |     });
  154 |     return context?.type === 'agent';
  155 |   } catch {
  156 |     return false;
  157 |   }
  158 | }
  159 | 
```