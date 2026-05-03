import { describe, expect, it, vi } from 'vitest';
import { AssemblyTranscriber } from './transcriber';

describe('AssemblyTranscriber', () => {
  it('routes partial and final transcript messages', () => {
    const partial = vi.fn();
    const final = vi.fn();
    const error = vi.fn();
    const transcriber = new AssemblyTranscriber({
      token: 'token',
      onPartialTranscript: partial,
      onFinalTranscript: final,
      onError: error
    });

    // @ts-expect-error exercising private message parser without opening a real socket
    transcriber.handleMessage({ data: JSON.stringify({ message_type: 'PartialTranscript', text: 'hel' }) });
    // @ts-expect-error exercising private message parser without opening a real socket
    transcriber.handleMessage({ data: JSON.stringify({ message_type: 'FinalTranscript', text: 'hello' }) });

    expect(partial).toHaveBeenCalledWith('hel');
    expect(final).toHaveBeenCalledWith('hello');
    expect(error).not.toHaveBeenCalled();
  });
});
