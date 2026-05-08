import { useEffect, useRef, useState } from 'react';
import type { ScreenCapturePayload } from '../shared/types';
import { useVoiceRecorder } from './useVoiceRecorder';

export function Recorder() {
  const { transcript, level, isRecording, startRecording, stopRecording } = useVoiceRecorder();
  const isRecordingRef = useRef(isRecording);
  const startRecordingRef = useRef(startRecording);
  const stopRecordingRef = useRef(stopRecording);
  const isStoppingRef = useRef(false);
  const realtimeFinalTranscriptRef = useRef('');
  const latestCursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rafIdRef = useRef<number>(0);
  const [status, setStatus] = useState<'idle' | 'listening' | 'processing'>('idle');
  const isE2ERef = useRef(window.clicky.e2e.isE2EModeSync);

  // Forward pointer position to the main process so it can track the cursor
  // on Wayland where screen.getCursorScreenPoint() returns {x:0, y:0}.
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      latestCursorRef.current = { x: e.screenX, y: e.screenY };
    };
    const tick = () => {
      const pos = latestCursorRef.current;
      if (pos.x !== 0 || pos.y !== 0) {
        window.clicky.sendCursorPosition(pos.x, pos.y);
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    rafIdRef.current = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  useEffect(() => {
    isRecordingRef.current = isRecording;
    startRecordingRef.current = startRecording;
    stopRecordingRef.current = stopRecording;
  });

  useEffect(() => {
    console.log('[clicky:orb] Recorder mounted and waiting for push-to-talk recording start');
    const isE2E = isE2ERef.current;
    console.log('[clicky:orb] E2E mode:', isE2E);

    const disposeStart = window.clicky.onRecordingStart(() => {
      console.log('[clicky:orb] recording start received', { isRecording: isRecordingRef.current });
      if (isE2E) {
        void handleE2EFlow();
      } else {
        void startCommandRecording();
      }
    });
    const disposeStop = window.clicky.onRecordingStop(() => {
      console.log('[clicky:orb] recording stop received', { isRecording: isRecordingRef.current });
      if (isRecordingRef.current) {
        void stopAndHandoff('hotkey-release');
      }
    });
    const disposeE2ETranscript = window.clicky.e2e.onInjectTranscript((text) => {
      console.log('[clicky:orb] E2E transcript injected', { text });
      handleE2ETranscript(text);
    });
    return () => {
      disposeStart();
      disposeStop();
      disposeE2ETranscript();
    };
  }, []);

  const pendingE2ETranscriptRef = useRef<string | undefined>(undefined);

  function handleE2EFlow() {
    isStoppingRef.current = false;
    setStatus('listening');
    if (pendingE2ETranscriptRef.current) {
      handleE2ETranscript(pendingE2ETranscriptRef.current);
    }
  }

  async function handleE2ETranscript(text: string) {
    const isE2E = isE2ERef.current;
    if (!isE2E) {
      pendingE2ETranscriptRef.current = text;
      return;
    }
    pendingE2ETranscriptRef.current = undefined;
    console.log('[clicky:orb] E2E: using injected transcript, bypassing mic', { chars: text.length });

    const finalTranscript = text.trim();
    if (!finalTranscript || isStoppingRef.current) return;
    isStoppingRef.current = true;
    setStatus('processing');

    const settings = await window.clicky.getSettings();
    const captures = await captureScreenIfUseful(finalTranscript);

    const request = {
      transcript: finalTranscript,
      captures,
      model: 'gpt-realtime-2',
      conversationHistory: []
    };

    console.log('[clicky:orb] E2E: spawning realtime agent from injected transcript');
    try {
      await window.clicky.spawnRealtimeAgent(request);
      console.log('[clicky:orb] E2E: realtime agent spawn IPC completed');
    } catch (err) {
      console.error('[clicky:orb] E2E: agent spawn failed:', err);
      await window.clicky.spawnAgentError('Agent spawn failed');
    }

    console.log('[clicky:orb] E2E: closing recorder window after handoff');
    window.close();
  }

  async function stopAndHandoff(reason: string) {
    if (isStoppingRef.current) {
      console.log('[clicky:orb] stop ignored because handoff is already running', { reason });
      return;
    }
    isStoppingRef.current = true;
    setStatus('processing');
    console.log('[clicky:orb] stopping active recording', { reason });
    const audio = await stopRecordingRef.current();
    window.clicky.notifyRecordingStopped();

    let finalTranscript = realtimeFinalTranscriptRef.current;
    realtimeFinalTranscriptRef.current = '';

    if (finalTranscript) {
      console.log('[clicky:orb] using Realtime final transcript', {
        chars: finalTranscript.length,
        transcript: finalTranscript
      });
    } else if (audio) {
      console.log('[clicky:orb] falling back to Whisper transcription', {
        bytes: audio.bytes.byteLength,
        mimeType: audio.mimeType
      });
      try {
        finalTranscript = await window.clicky.transcribeAudio(audio);
        console.log('[clicky:orb] Whisper transcription received', {
          chars: finalTranscript.length,
          transcript: finalTranscript
        });
      } catch (err) {
        console.error('[clicky:orb] Whisper transcription failed:', err);
        await window.clicky.spawnAgentError('Transcription Failed: Please check your OpenAI API key or internet connection');
        window.close();
        return;
      }
    }

    if (!finalTranscript?.trim()) {
      console.warn('[clicky:orb] empty transcript; closing orb');
      window.close();
      return;
    }

    const settings = await window.clicky.getSettings();
    const captures = await captureScreenIfUseful(finalTranscript);

    const request = {
      transcript: finalTranscript.trim(),
      captures,
      model: 'gpt-realtime-2',
      conversationHistory: []
    };

    console.log('[clicky:orb] spawning agent from transcript');
    try {
      await window.clicky.spawnRealtimeAgent(request);
      console.log('[clicky:orb] agent spawn IPC completed');
    } catch (err) {
      console.error('[clicky:orb] agent spawn failed:', err);
      await window.clicky.spawnAgentError('Agent spawn failed');
    }

    console.log('[clicky:orb] closing recorder window after handoff');
    window.close();
  }

  async function startCommandRecording() {
    if (isRecordingRef.current) {
      console.warn('[clicky:orb] start ignored because recording is already active');
      return;
    }
    isStoppingRef.current = false;
    realtimeFinalTranscriptRef.current = '';
    console.log('[clicky:orb] wake word handoff received; starting command recording');
    setStatus('listening');

    console.log('[clicky:orb] starting microphone recording with silence auto-stop');
    await startRecordingRef.current({
      silenceMs: 2000,
      useRealtime: true,
      onSilence: () => {
        void stopAndHandoff('silence-timeout');
      },
      onFinalTranscript: (text) => {
        realtimeFinalTranscriptRef.current = text;
        void stopAndHandoff('realtime-final');
      },
      onRealtimeError: (message) => {
        console.error('[clicky:orb] realtime transcription error:', message);
      }
    });
    console.log('[clicky:orb] microphone recording started');
  }

  async function captureScreenIfUseful(transcriptText: string): Promise<ScreenCapturePayload[]> {
    if (!shouldCaptureScreen(transcriptText)) {
      console.log('[clicky:orb] screen context skipped for transcript');
      return [];
    }

    console.log('[clicky:orb] capturing screen context after transcript');
    try {
      const capture = await withTimeout(window.clicky.takeScreenshot(), 1200);
      console.log('[clicky:orb] screen context captured', {
        label: capture.label,
        width: capture.width,
        height: capture.height
      });
      return [capture];
    } catch (err) {
      console.error('[clicky:orb] screen context capture failed:', err);
      return [];
    }
  }

  return (
    <div className="listening-orb">
      <div className="orb-circle">
        {status === 'idle' && <div className="idle-cursor" />}
        {status === 'listening' ? (
          <div className="waveform">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="waveform-bar"
                style={{
                  transform: `scaleY(${0.4 + level * 1.2})`
                }}
              />
            ))}
          </div>
        ) : status === 'processing' ? (
          <div className="loading-spinner">
            <div className="spinner-dot" />
            <div className="spinner-dot" />
            <div className="spinner-dot" />
          </div>
        ) : null}
      </div>

    </div>
  );
}

function shouldCaptureScreen(transcript: string): boolean {
  return /\b(this|that|screen|page|window|image|picture|what (?:is|are)|what's|look|see|visible|shown|displayed|about)\b/i.test(transcript);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
