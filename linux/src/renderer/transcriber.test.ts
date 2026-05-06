import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeTranscriber } from './transcriber';

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: unknown[] = [];
  closed = false;

  addEventListener(type: string, handler: (event: unknown) => void) {
    if (type === 'message') this.onmessage = handler as (event: MessageEvent<string>) => void;
    if (type === 'error') this.onerror = handler as (event: Event) => void;
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 'closed';
  }

  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  dataChannel = new FakeDataChannel();
  senders: Array<{ track?: { kind: string; enabled: boolean; stop: () => void } }> = [];
  stateHandler?: () => void;
  closed = false;

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.dataChannel;
  }

  addTrack(track: { kind: string; enabled: boolean; stop: () => void }) {
    this.senders.push({ track });
  }

  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' } as RTCSessionDescriptionInit;
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  addEventListener(type: string, handler: () => void) {
    if (type === 'connectionstatechange') this.stateHandler = handler;
  }

  removeEventListener(type: string, handler: () => void) {
    if (type === 'connectionstatechange' && this.stateHandler === handler) this.stateHandler = undefined;
  }

  getSenders() {
    return this.senders;
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  simulateConnected() {
    this.connectionState = 'connected';
    this.stateHandler?.();
  }
}

describe('OpenAIRealtimeTranscriber', () => {
  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    // @ts-expect-error mocking browser WebRTC APIs for tests
    global.RTCPeerConnection = FakeRTCPeerConnection;
    global.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as typeof WebSocket;
    vi.stubGlobal('window', {
      clicky: {
        createRealtimeCall: vi.fn(async () => ({ answerSdp: 'answer-sdp' }))
      }
    });
  });

  it('creates a WebRTC call with local offer SDP', async () => {
    const transcriber = new OpenAIRealtimeTranscriber({
      model: 'gpt-4o-mini-transcribe',
      sampleRate: 24000,
      onPartialTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onError: vi.fn()
    });

    const track = { kind: 'audio', enabled: true, stop: vi.fn() };
    const startPromise = transcriber.start({ getAudioTracks: () => [track] } as unknown as MediaStream);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.simulateConnected();
    await startPromise;

    expect(window.clicky.createRealtimeCall).toHaveBeenCalledWith('offer-sdp');
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    expect(pc.getSenders()).toHaveLength(1);
  });

  it('emits partial transcript updates from data channel events', async () => {
    const partial = vi.fn();
    const transcriber = new OpenAIRealtimeTranscriber({
      model: 'gpt-4o-mini-transcribe',
      sampleRate: 24000,
      onPartialTranscript: partial,
      onFinalTranscript: vi.fn(),
      onError: vi.fn()
    });

    const startPromise = transcriber.start({ getAudioTracks: () => [] } as unknown as MediaStream);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.simulateConnected();
    await startPromise;

    pc.dataChannel.simulateMessage(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta',
      delta: 'Hello'
    }));

    expect(partial).toHaveBeenCalledWith('Hello');
  });

  it('waits for a final transcript before closing media', async () => {
    const final = vi.fn();
    const track = { kind: 'audio', enabled: true, stop: vi.fn() };
    const transcriber = new OpenAIRealtimeTranscriber({
      model: 'gpt-4o-mini-transcribe',
      sampleRate: 24000,
      onPartialTranscript: vi.fn(),
      onFinalTranscript: final,
      onError: vi.fn()
    });

    const startPromise = transcriber.start({ getAudioTracks: () => [track] } as unknown as MediaStream);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.simulateConnected();
    await startPromise;

    const finishPromise = transcriber.finish(1000);
    expect(track.enabled).toBe(false);

    pc.dataChannel.simulateMessage(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Finished text'
    }));

    await expect(finishPromise).resolves.toBe('Finished text');
    expect(final).toHaveBeenCalledWith('Finished text');
  });

  it('surfaces malformed/error events and closes resources cleanly', async () => {
    const error = vi.fn();
    const track = { kind: 'audio', enabled: true, stop: vi.fn() };
    const transcriber = new OpenAIRealtimeTranscriber({
      model: 'gpt-4o-mini-transcribe',
      sampleRate: 24000,
      onPartialTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onError: error
    });

    const startPromise = transcriber.start({ getAudioTracks: () => [track] } as unknown as MediaStream);
    const pc = FakeRTCPeerConnection.instances[0];
    pc.simulateConnected();
    await startPromise;

    pc.dataChannel.simulateMessage('not json');
    expect(error).toHaveBeenCalledWith('Malformed transcription message');

    error.mockClear();
    pc.dataChannel.simulateMessage(JSON.stringify({
      type: 'error',
      error: { message: 'something went wrong' }
    }));
    expect(error).toHaveBeenCalledWith('something went wrong');

    transcriber.close();
    expect(pc.dataChannel.closed).toBe(true);
    expect(pc.closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    expect(transcriber.readyState).toBe(3);
  });
});
