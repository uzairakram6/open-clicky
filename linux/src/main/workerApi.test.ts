import { describe, expect, it } from 'vitest';
import {
  buildOpenAIMessages,
  buildRealtimeAgentSession,
  isRealtimeModel,
  resolveChatCompletionsModel,
  sanitizeOpenAIErrorBody,
  writeFileTool
} from './workerApi';

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
    expect(system.content).toContain('tools for shell commands, writing files, email, URLs, website scraping, downloading email attachments, reading local files, and opening local files');
    expect(system.content).toContain('<<<HEADER>>>');
    expect(system.content).toContain('<<<UI>>>');
    expect(system.content).toContain('<<<SPOKEN>>>');
    expect(system.content).toContain('xdg-open');
  });

  it('builds the GPT-Realtime-2 agent session payload', () => {
    const session = buildRealtimeAgentSession() as {
      model: string;
      reasoning: { effort: string };
      audio: { input: { transcription: { model: string; language: string; prompt: string }; turn_detection: null }; output: { voice: string } };
      tools: Array<{ name: string }>;
    };

    expect(session.model).toBe('gpt-realtime-2');
    expect(session.audio.output.voice).toBe('marin');
    expect(session.reasoning.effort).toBe('medium');
    expect(session.audio.input.transcription.model).toBe('gpt-realtime-whisper');
    expect(session.audio.input.transcription.language).toBe('en');
    expect(session.audio.input.transcription.prompt).toContain('English only');
    expect(session.audio.input.turn_detection).toBeNull();
    expect((session as unknown as { instructions: string }).instructions).toContain('# Preambles');
    expect((session as unknown as { instructions: string }).instructions).toContain('one natural preamble');
    expect((session as unknown as { instructions: string }).instructions).toContain('Do not give suggestions before tool calls');
    expect(session.tools.map((tool) => tool.name)).toEqual([
      'execute_bash_command',
      'write_file',
      'check_email',
      'open_url',
      'scrape_website',
      'download_email_attachment',
      'read_file',
      'open_file'
    ]);
  });

  it('does not route realtime models into Chat Completions', () => {
    expect(isRealtimeModel('gpt-realtime-2')).toBe(true);
    expect(isRealtimeModel('gpt-realtime')).toBe(true);
    expect(isRealtimeModel('gpt-5.4-mini')).toBe(false);

    expect(resolveChatCompletionsModel('gpt-realtime-2')).toBe('gpt-5.4-mini');
    expect(resolveChatCompletionsModel('gpt-realtime-2', 'gpt-5.4')).toBe('gpt-5.4');
    expect(resolveChatCompletionsModel('gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });

  it('sanitizes OpenAI HTML error pages before surfacing them', () => {
    const body = '<!DOCTYPE html><html><head><title>api.openai.com | 504: Gateway time-out</title><style>.x{}</style></head><body><script>alert(1)</script><h1>Gateway time-out</h1><p>The web server reported a gateway time-out error.</p></body></html>';

    const sanitized = sanitizeOpenAIErrorBody(body);

    expect(sanitized).toContain('504: Gateway time-out');
    expect(sanitized).toContain('The web server reported a gateway time-out error.');
    expect(sanitized).not.toContain('<html>');
    expect(sanitized).not.toContain('<script>');
  });
});
