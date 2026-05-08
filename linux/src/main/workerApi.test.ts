import { describe, expect, it } from 'vitest';
import { buildOpenAIMessages, buildRealtimeAgentSession, writeFileTool } from './workerApi';

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
    expect(system.content).toContain('execute_bash_command, write_file, check_email, open_url, scrape_website, and download_email_attachment');
    expect(system.content).toContain('<<<HEADER>>>');
    expect(system.content).toContain('<<<UI>>>');
    expect(system.content).toContain('<<<SPOKEN>>>');
    expect(system.content).toContain('xdg-open');
  });

  it('builds the GPT-Realtime-2 agent session payload', () => {
    const session = buildRealtimeAgentSession() as {
      model: string;
      voice: string;
      reasoning: { effort: string };
      audio: { input: { transcription: { model: string }; turn_detection: null } };
      tools: Array<{ name: string }>;
    };

    expect(session.model).toBe('gpt-realtime-2');
    expect(session.voice).toBe('marin');
    expect(session.reasoning.effort).toBe('medium');
    expect(session.audio.input.transcription.model).toBe('gpt-realtime-whisper');
    expect(session.audio.input.turn_detection).toBeNull();
    expect((session as unknown as { instructions: string }).instructions).toContain('Checking your email now.');
    expect((session as unknown as { instructions: string }).instructions).toContain('Do not give suggestions before tool calls');
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'execute_bash_command',
      'write_file',
      'check_email',
      'open_url',
      'scrape_website',
      'download_email_attachment'
    ]);
  });
});
