import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildChatPayload, WorkerApi } from './workerApi';

describe('Worker request payloads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches the /chat contract shape', () => {
    const payload = buildChatPayload({
      transcript: 'what is on screen?',
      captures: [{ jpegBase64: 'abc', label: 'selected Linux screen', width: 1280, height: 720 }],
      model: 'claude-3-5-sonnet-latest',
      conversationHistory: [{ role: 'user', content: 'previous' }]
    });

    expect(payload).toEqual({
      transcript: 'what is on screen?',
      captures: [{ jpegBase64: 'abc', label: 'selected Linux screen', width: 1280, height: 720 }],
      model: 'claude-3-5-sonnet-latest',
      conversationHistory: [{ role: 'user', content: 'previous' }]
    });
  });

  it('requests AssemblyAI tokens through the Worker', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ token: 'abc' })));
    const api = new WorkerApi({ workerBaseUrl: 'https://worker.example' });

    await expect(api.getTranscribeToken()).resolves.toEqual({ token: 'abc' });
    expect(fetchMock).toHaveBeenCalledWith('https://worker.example/transcribe-token', { method: 'POST' });
  });

  it('sends sanitized text to /tts and returns audio bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
    const api = new WorkerApi({ workerBaseUrl: 'https://worker.example' });

    await expect(api.synthesizeSpeech('hello [POINT:a] world')).resolves.toBeInstanceOf(ArrayBuffer);
    expect(fetchMock).toHaveBeenCalledWith('https://worker.example/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello world' })
    });
  });
});
