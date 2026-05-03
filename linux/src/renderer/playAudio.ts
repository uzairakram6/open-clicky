export function playAudioBytes(audio: ArrayBuffer): void {
  const blob = new Blob([audio], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);
  player.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
  void player.play();
}
