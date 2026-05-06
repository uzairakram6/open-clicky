import { describe, expect, it } from 'vitest';
import { floatToPcm16, resampleFloat32 } from './audio';

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

describe('resampleFloat32', () => {
  it('returns a copy when rates are equal', () => {
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const output = resampleFloat32(input, 48000, 48000);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  it('downsamples from 48000 to 24000 producing half the samples', () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const output = resampleFloat32(input, 48000, 24000);
    expect(output.length).toBe(4);
    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[1]).toBeCloseTo(2, 5);
    expect(output[2]).toBeCloseTo(4, 5);
    expect(output[3]).toBeCloseTo(6, 5);
  });

  it('downsamples from 44100 to 24000 with approximately the expected ratio', () => {
    const inputLength = 44100;
    const input = new Float32Array(inputLength);
    for (let i = 0; i < inputLength; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / inputLength);
    }
    const output = resampleFloat32(input, 44100, 24000);
    const expectedLength = Math.round(inputLength * (24000 / 44100));
    expect(output.length).toBe(expectedLength);
  });

  it('interpolates a simple ramp correctly', () => {
    const input = new Float32Array([0, 2, 4, 6]);
    const output = resampleFloat32(input, 4, 3);
    expect(output.length).toBe(3);
    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[1]).toBeCloseTo(2.666_666_7, 5);
    expect(output[2]).toBeCloseTo(5.333_333_3, 5);
  });

  it('handles a single-sample input', () => {
    const input = new Float32Array([0.5]);
    const output = resampleFloat32(input, 48000, 24000);
    expect(output.length).toBe(1);
    expect(output[0]).toBeCloseTo(0.5, 5);
  });
});
