export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

export function resampleFloat32(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) {
    return new Float32Array(input);
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;

    const a = input[index];
    const b = input[Math.min(index + 1, input.length - 1)];

    output[i] = a + (b - a) * fraction;
  }

  return output;
}

export function int16ToBase64(input: Int16Array): string {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
