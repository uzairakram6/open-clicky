import { floatToPcm16, int16ToBase64 } from '../shared/audio';

export interface AssemblyTranscriberOptions {
  token: string;
  onPartialTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (message: string) => void;
}

export class AssemblyTranscriber {
  private context?: AudioContext;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private socket?: WebSocket;

  constructor(private readonly options: AssemblyTranscriberOptions) {}

  async start(stream: MediaStream): Promise<void> {
    this.socket = new WebSocket(`wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${encodeURIComponent(this.options.token)}`);
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
    this.socket.addEventListener('error', () => this.options.onError('AssemblyAI transcription socket failed'));

    await new Promise<void>((resolve, reject) => {
      if (!this.socket) return reject(new Error('Socket was not created'));
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Unable to open AssemblyAI transcription socket')), { once: true });
    });

    this.context = new AudioContext({ sampleRate: 16000 });
    this.source = this.context.createMediaStreamSource(stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const pcm = floatToPcm16(event.inputBuffer.getChannelData(0));
      this.send({ audio_data: int16ToBase64(pcm) });
    };
    this.source.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    this.send({ terminate_session: true });
    this.processor?.disconnect();
    this.source?.disconnect();
    await this.context?.close();
    this.socket?.close();
  }

  private handleMessage(event: MessageEvent<string>): void {
    try {
      const payload = JSON.parse(event.data) as { message_type?: string; text?: string; error?: string };
      if (payload.error) {
        this.options.onError(payload.error);
      } else if (payload.message_type === 'PartialTranscript' && payload.text) {
        this.options.onPartialTranscript(payload.text);
      } else if (payload.message_type === 'FinalTranscript' && payload.text) {
        this.options.onFinalTranscript(payload.text);
      }
    } catch {
      this.options.onError('Malformed transcription message');
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
