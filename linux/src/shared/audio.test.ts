import { describe, expect, it } from 'vitest';
import { floatToPcm16 } from './audio';

describe('floatToPcm16', () => {
  it('clamps and encodes PCM16 samples', () => {
    expect(Array.from(floatToPcm16(new Float32Array([-2, -1, 0, 0.5, 1, 2])))).toEqual([
      -32768,
      -32768,
      0,
      16383,
      32767,
      32767
    ]);
  });
});
