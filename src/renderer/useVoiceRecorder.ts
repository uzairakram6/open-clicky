import { useCallback, useRef, useState } from 'react';
import { OpenAIRealtimeTranscriber } from './transcriber';
import type { RecordedAudioPayload, TranscribeTokenResponse } from '../shared/types';

export interface VoiceRecorderState {
  transcript: string;
  level: number;
  isRecording: boolean;
}

export interface StartRecordingOptions {
  onSilence?: () => void;
  silenceMs?: number;
  silenceThreshold?: number;
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
  onRealtimeError?: (message: string) => void;
  useRealtime?: boolean;
  transcribeToken?: TranscribeTokenResponse;
}

export function useVoiceRecorder() {
  const [transcript, setTranscript] = useState('');
  const [level, setLevel] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const recordingStartedAtRef = useRef(0);
  const silenceStartedAtRef = useRef<number | undefined>(undefined);
  const silenceTriggeredRef = useRef(false);
  const optionsRef = useRef<StartRecordingOptions>({});
  const transcriberRef = useRef<OpenAIRealtimeTranscriber | undefined>(undefined);

  const startRecording = useCallback(async (options: StartRecordingOptions = {}) => {
    console.log('[clicky:recorder] startRecording requested');
    optionsRef.current = options;
    recordingStartedAtRef.current = Date.now();
    silenceStartedAtRef.current = undefined;
    silenceTriggeredRef.current = false;
    setTranscript('');
    setLevel(0);
    chunksRef.current = [];

    console.log('[clicky:recorder] requesting microphone access');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    console.log('[clicky:recorder] microphone stream acquired', {
      audioTracks: stream.getAudioTracks().map((track) => ({
        id: track.id,
        label: track.label,
        enabled: track.enabled,
        muted: track.muted,
        readyState: track.readyState
      }))
    });
    const mimeType = preferredMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        chunksRef.current = [...chunksRef.current, event.data];
        console.log('[clicky:recorder] audio chunk captured', {
          size: event.data.size,
          type: event.data.type,
          chunks: chunksRef.current.length
        });
      }
    });

    const context = new AudioContext();
    audioContextRef.current = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    const samples = new Float32Array(analyser.fftSize);
    source.connect(analyser);

    if (options.useRealtime || options.transcribeToken) {
      const transcriber = new OpenAIRealtimeTranscriber({
        model: options.transcribeToken?.model ?? 'gpt-4o-mini-transcribe',
        sampleRate: options.transcribeToken?.sampleRate ?? 24000,
        onPartialTranscript: (text) => {
          setTranscript((current) => {
            const updated = current + text;
            options.onPartialTranscript?.(updated);
            return updated;
          });
        },
        onFinalTranscript: (text) => {
          setTranscript(text);
          options.onFinalTranscript?.(text);
        },
        onError: (message) => {
          console.error('[clicky:recorder] realtime transcriber error:', message);
          options.onRealtimeError?.(message);
        }
      });
      transcriberRef.current = transcriber;
      try {
        await transcriber.start(stream);
        console.log('[clicky:recorder] realtime transcriber connected');
      } catch (err) {
        console.error('[clicky:recorder] realtime transcriber connection failed:', err);
        options.onRealtimeError?.('Failed to connect to realtime transcription');
        transcriberRef.current = undefined;
      }
    }

    const tick = () => {
      if (!streamRef.current) {
        void context.close();
        return;
      }
      analyser.getFloatTimeDomainData(samples);

      const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
      setLevel(Math.min(1, peak * 3));
      handleSilence(peak);
      requestAnimationFrame(tick);
    };
    tick();

    recorder.start();
    setIsRecording(true);
    console.log('[clicky:recorder] MediaRecorder started', {
      mimeType: recorder.mimeType,
      state: recorder.state
    });
  }, []);

  const stopRecording = useCallback(async (): Promise<RecordedAudioPayload | undefined> => {
    console.log('[clicky:recorder] stopRecording requested');
    silenceTriggeredRef.current = true;
    const recorder = recorderRef.current;
    const stopped = recorder ? waitForRecorderStop(recorder) : Promise.resolve();
    if (recorder?.state === 'recording') {
      console.log('[clicky:recorder] stopping MediaRecorder', { state: recorder.state });
      recorder.stop();
    } else {
      console.log('[clicky:recorder] MediaRecorder was not recording', { state: recorder?.state });
    }
    await stopped;
    console.log('[clicky:recorder] MediaRecorder stopped');
    recorderRef.current = undefined;

    const finalTranscript = await transcriberRef.current?.finish();
    if (finalTranscript) {
      console.log('[clicky:recorder] realtime transcription final received during stop', {
        chars: finalTranscript.length
      });
    } else if (transcriberRef.current) {
      console.warn('[clicky:recorder] realtime transcription final not received before timeout');
    }
    transcriberRef.current?.close();
    transcriberRef.current = undefined;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = undefined;
    }
    setLevel(0);
    setIsRecording(false);
    const mimeType = chunksRef.current[0]?.type || recorder?.mimeType || 'audio/webm';
    const blob = new Blob(chunksRef.current, { type: mimeType });
    setTranscript('');
    chunksRef.current = [];
    optionsRef.current = {};
    if (blob.size === 0) {
      console.warn('[clicky:recorder] recording produced no audio bytes');
      return undefined;
    }
    console.log('[clicky:recorder] recording finalized', {
      bytes: blob.size,
      mimeType
    });
    return {
      bytes: await blob.arrayBuffer(),
      mimeType
    };
  }, []);

  return {
    transcript,
    level,
    isRecording,
    startRecording,
    stopRecording
  };

  function handleSilence(peak: number): void {
    const options = optionsRef.current;
    if (!options.onSilence || silenceTriggeredRef.current) return;

    const now = Date.now();
    const graceMs = 900;
    if (now - recordingStartedAtRef.current < graceMs) return;

    const threshold = options.silenceThreshold ?? 0.018;
    const silenceMs = options.silenceMs ?? 2000;
    if (peak >= threshold) {
      silenceStartedAtRef.current = undefined;
      return;
    }

    silenceStartedAtRef.current ??= now;
    const elapsed = now - silenceStartedAtRef.current;
    if (elapsed >= silenceMs) {
      silenceTriggeredRef.current = true;
      console.log('[clicky:recorder] silence timeout reached', {
        silenceMs,
        threshold,
        peak
      });
      options.onSilence();
    }
  }
}

function preferredMimeType(): string | undefined {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/wav'
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function waitForRecorderStop(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === 'inactive') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
  });
}
