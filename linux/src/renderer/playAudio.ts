let currentPlayer: HTMLAudioElement | undefined;
let currentUrl: string | undefined;

export function playAudioBytes(audio: ArrayBuffer): void {
  if (currentPlayer) {
    currentPlayer.pause();
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }

  const blob = new Blob([audio], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);
  currentPlayer = player;
  currentUrl = url;
  player.addEventListener('ended', () => {
    if (currentPlayer === player) {
      currentPlayer = undefined;
      currentUrl = undefined;
    }
    URL.revokeObjectURL(url);
  }, { once: true });
  void player.play();
}

export function stopAudioPlayback(): void {
  if (currentPlayer) {
    currentPlayer.pause();
    currentPlayer = undefined;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = undefined;
  }
}
