import { afterEach, describe, expect, it, vi } from 'vitest';
import { playAudioBytes } from './playAudio';

describe('playAudioBytes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
