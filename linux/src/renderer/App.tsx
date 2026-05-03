import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { floatToPcm16, int16ToBase64 } from '../shared/audio';
import { stripPointTags } from '../shared/pointTags';
import type { AppSettings, CaptureSource, ConversationMessage, ScreenCapturePayload, VoiceState } from '../shared/types';
import { playAudioBytes } from './playAudio';
import { AssemblyTranscriber } from './transcriber';
import './styles.css';

const models = ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'];

function App() {
  const [settings, setSettings] = useState<AppSettings>();
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [history, setHistory] = useState<ConversationMessage[]>([]);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const transcriberRef = useRef<AssemblyTranscriber | undefined>(undefined);
  const chunksRef = useRef<string[]>([]);

  useEffect(() => {
    void window.clicky.getSettings().then(setSettings);
    return combineDisposers(
      window.clicky.onVoiceToggle(() => void toggleRecording()),
      window.clicky.onChatChunk((text) => {
        setVoiceState('responding');
        setResponse((current) => stripPointTags(`${current}${text}`));
      }),
      window.clicky.onChatDone(() => {
        setVoiceState('idle');
        setResponse((current) => {
          const clean = stripPointTags(current);
          if (clean) void window.clicky.speak(clean);
          setHistory((items) => [...items, { role: 'assistant', content: clean }]);
          return clean;
        });
      }),
      window.clicky.onChatError((message) => {
        setError(message);
        setVoiceState('idle');
      }),
      window.clicky.onTtsAudio(playAudioBytes),
      window.clicky.onTtsError(setError)
    );
  }, []);

  const captureStatus = useMemo(() => settings?.selectedCaptureSourceLabel ?? 'No screen selected', [settings]);

  async function toggleRecording() {
    if (voiceState === 'listening') {
      await stopRecordingAndSend();
      return;
    }

    setError('');
    setResponse('');
    setTranscript('');
    chunksRef.current = [];
    setVoiceState('listening');

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    monitorAudioLevel(stream);

    try {
      const { token } = await window.clicky.getTranscribeToken();
      transcriberRef.current = new AssemblyTranscriber({
        token,
        onPartialTranscript: setTranscript,
        onFinalTranscript: (text) => {
          chunksRef.current = [...chunksRef.current, text];
          setTranscript(chunksRef.current.join(' ').trim());
        },
        onError: setError
      });
      await transcriberRef.current.start(stream);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function stopRecordingAndSend() {
    await transcriberRef.current?.stop();
    transcriberRef.current = undefined;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    setLevel(0);
    setVoiceState('processing');

    const finalTranscript = transcript.trim();
    if (!finalTranscript || !settings) {
      setVoiceState('idle');
      return;
    }

    const captures: ScreenCapturePayload[] = [];
    try {
      captures.push(await window.clicky.captureSelectedScreen());
    } catch (reason) {
      setError(`Screen capture skipped: ${String(reason)}`);
    }

    const request = {
      transcript: finalTranscript,
      captures,
      model: settings.model,
      conversationHistory: history
    };

    setHistory((items) => [...items, { role: 'user', content: finalTranscript }]);
    await window.clicky.sendTurn(request);
  }

  async function refreshSources() {
    const nextSources = await window.clicky.selectScreens();
    setSources(nextSources);
    if (nextSources.length === 0) {
      setError('No screen sources were returned by the desktop capture service');
    }
  }

  async function selectSource(source: CaptureSource) {
    const next = await window.clicky.setSelectedScreen(source);
    setSettings(next);
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    if (!settings) return;
    setSettings(await window.clicky.setSettings({ ...settings, ...patch, onboarded: true }));
  }

  function monitorAudioLevel(stream: MediaStream) {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const samples = new Float32Array(analyser.fftSize);
    source.connect(analyser);

    const tick = () => {
      if (!streamRef.current) {
        void context.close();
        return;
      }

      analyser.getFloatTimeDomainData(samples);
      const pcm = floatToPcm16(samples);
      int16ToBase64(pcm.slice(0, 8));
      const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      setLevel(Math.min(1, peak * 3));
      requestAnimationFrame(tick);
    };
    tick();
  }

  if (!settings) {
    return <main className="shell">Loading</main>;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Clicky</h1>
          <p>{voiceState}</p>
        </div>
        <button onClick={() => void toggleRecording()}>{voiceState === 'listening' ? 'Stop' : 'Record'}</button>
      </header>

      <section className="controls">
        <label>
          Worker URL
          <input value={settings.workerBaseUrl} onChange={(event) => void updateSettings({ workerBaseUrl: event.target.value })} />
        </label>
        <label>
          Model
          <select value={settings.model} onChange={(event) => void updateSettings({ model: event.target.value })}>
            {models.map((model) => <option key={model}>{model}</option>)}
          </select>
        </label>
        <label>
          Shortcut
          <input value={settings.shortcut} onChange={(event) => void updateSettings({ shortcut: event.target.value })} />
        </label>
      </section>

      <section className="capture">
        <div>
          <strong>Capture</strong>
          <span>{captureStatus}</span>
        </div>
        <button onClick={() => void refreshSources()}>Screens</button>
      </section>

      {sources.length > 0 && (
        <section className="sources">
          {sources.map((source) => (
            <button key={source.id} onClick={() => void selectSource(source)}>
              {source.thumbnailDataUrl && <img src={source.thumbnailDataUrl} alt="" />}
              <span>{source.label}</span>
            </button>
          ))}
        </section>
      )}

      <section className="meter" aria-label="Audio level">
        <span style={{ width: `${level * 100}%` }} />
      </section>

      <label className="transcript">
        Transcript
        <textarea value={transcript} onChange={(event) => setTranscript(event.target.value)} placeholder="Speak, or type a transcript for testing." />
      </label>

      <section className="response">
        <strong>Response</strong>
        <p>{response || 'Waiting for a turn.'}</p>
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}

function combineDisposers(...disposers: Array<() => void>) {
  return () => disposers.forEach((dispose) => dispose());
}

createRoot(document.getElementById('root')!).render(<App />);
