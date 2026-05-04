import { describe, expect, it } from 'vitest';
import { buildOpenAIMessages, writeFileTool } from './workerApi';

describe('Worker API app-generation harness', () => {
  it('defines the write_file tool for generated app files', () => {
    expect(writeFileTool.function.name).toBe('write_file');
    expect(writeFileTool.function.parameters.required).toEqual(['file_path', 'content']);
    expect(writeFileTool.function.description).toContain('/tmp/clicky_apps');
  });

  it('instructs the model to write and launch minimal local apps', () => {
    const messages = buildOpenAIMessages({
      transcript: 'Build a stopwatch website',
      captures: [],
      model: 'gpt-4o',
      conversationHistory: []
    });

    const system = messages[0] as { role: string; content: string };
    expect(system.role).toBe('system');
    expect(system.content).toContain('execute_bash_command, write_file, check_email, open_url, and scrape_website');
    expect(system.content).toContain('/tmp/clicky_apps/<short-name>/');
    expect(system.content).toContain('xdg-open');
  });
});
