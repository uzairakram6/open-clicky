export interface RealtimeTranscriberOptions {
  model: string;
  sampleRate: number;
  onPartialTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (message: string) => void;
}

export class OpenAIRealtimeTranscriber {
  private pc?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private ready = false;
  private finalTranscript = '';
  private finalWaiters: Array<(text: string | undefined) => void> = [];

  constructor(private readonly options: RealtimeTranscriberOptions) {}

  async start(stream: MediaStream): Promise<void> {
    this.pc = new RTCPeerConnection();
    this.dataChannel = this.pc.createDataChannel('oai-events');
    this.dataChannel.addEventListener('message', (event) => this.handleMessage(event));
    this.dataChannel.addEventListener('error', () => this.options.onError('Realtime transcription data channel failed'));

    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    const answer = await window.clicky.createRealtimeCall(offer.sdp ?? '');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.answerSdp });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for Realtime WebRTC connection'));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.pc?.removeEventListener('connectionstatechange', onStateChange);
      };

      const onStateChange = () => {
        if (this.pc?.connectionState === 'connected') {
          cleanup();
          resolve();
        } else if (this.pc?.connectionState === 'failed' || this.pc?.connectionState === 'closed') {
          cleanup();
          reject(new Error(`Realtime WebRTC connection ${this.pc.connectionState}`));
        }
      };

      this.pc?.addEventListener('connectionstatechange', onStateChange);
      onStateChange();
    });
  }

  commit(): void {
    this.pc?.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') {
        sender.track.enabled = false;
      }
    });
  }

  finish(timeoutMs = 1600): Promise<string | undefined> {
    this.commit();
    if (this.finalTranscript) {
      return Promise.resolve(this.finalTranscript);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.finalWaiters = this.finalWaiters.filter((waiter) => waiter !== resolve);
        resolve(undefined);
      }, timeoutMs);

      this.finalWaiters.push((text) => {
        clearTimeout(timeout);
        resolve(text);
      });
    });
  }

  close(): void {
    this.pc?.getSenders().forEach((sender) => sender.track?.stop());
    this.dataChannel?.close();
    this.pc?.close();
    this.ready = false;
  }

  get readyState(): number {
    if (!this.pc || this.pc.connectionState === 'closed') return WebSocket.CLOSED;
    if (this.pc.connectionState === 'connected') return WebSocket.OPEN;
    if (this.pc.connectionState === 'connecting' || this.pc.connectionState === 'new') return WebSocket.CONNECTING;
    return WebSocket.CLOSING;
  }

  private handleMessage(event: MessageEvent<string>): void {
    try {
      const payload = JSON.parse(event.data) as {
        type?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
      };
      if (payload.type === 'session.created' || payload.type === 'transcription_session.created') {
        this.ready = true;
      } else if (payload.type === 'conversation.item.input_audio_transcription.delta' && payload.delta) {
        this.options.onPartialTranscript(payload.delta);
      } else if (payload.type === 'conversation.item.input_audio_transcription.completed' && payload.transcript) {
        this.finalTranscript = payload.transcript;
        this.options.onFinalTranscript(payload.transcript);
        const waiters = this.finalWaiters;
        this.finalWaiters = [];
        waiters.forEach((resolve) => resolve(payload.transcript));
      } else if (payload.type === 'error') {
        this.options.onError(payload.error?.message ?? 'Realtime transcription error');
      }
    } catch {
      this.options.onError('Malformed transcription message');
    }
  }

  private send(payload: unknown): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(payload));
    }
  }
}
