import { afterEach, describe, expect, it, vi } from 'vitest';
import { playAudioBytes, stopAudioPlayback } from './playAudio';

describe('playAudioBytes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('turns TTS bytes into an audio object and starts playback', () => {
    const play = vi.fn();
    const addEventListener = vi.fn();
    const AudioMock = vi.fn(() => ({ addEventListener, play }));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tts');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('Audio', AudioMock);

    playAudioBytes(new Uint8Array([1, 2, 3]).buffer);

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(AudioMock).toHaveBeenCalledWith('blob:tts');
    expect(addEventListener).toHaveBeenCalledWith('ended', expect.any(Function), { once: true });
    expect(play).toHaveBeenCalled();

    const onEnded = addEventListener.mock.calls[0][1] as () => void;
    onEnded();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts');
  });

  it('stops the previous TTS audio before starting a newer one', () => {
    const first = { addEventListener: vi.fn(), pause: vi.fn(), play: vi.fn() };
    const second = { addEventListener: vi.fn(), pause: vi.fn(), play: vi.fn() };
    const AudioMock = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('Audio', AudioMock);

    playAudioBytes(new Uint8Array([1]).buffer);
    playAudioBytes(new Uint8Array([2]).buffer);

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(first.pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');
    expect(second.play).toHaveBeenCalled();
  });

  it('stops the current TTS audio on demand', () => {
    const player = { addEventListener: vi.fn(), pause: vi.fn(), play: vi.fn() };
    vi.stubGlobal('Audio', vi.fn(() => player));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:tts');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    playAudioBytes(new Uint8Array([1]).buffer);
    stopAudioPlayback();

    expect(player.pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tts');
  });
});
