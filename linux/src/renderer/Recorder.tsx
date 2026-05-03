import { useEffect, useRef, useState } from 'react';
import type { ScreenCapturePayload } from '../shared/types';
import { useVoiceRecorder } from './useVoiceRecorder';

export function Recorder() {
  const { level, isRecording, startRecording, stopRecording } = useVoiceRecorder();
  const isRecordingRef = useRef(isRecording);
  const startRecordingRef = useRef(startRecording);
  const stopRecordingRef = useRef(stopRecording);
  const captureRef = useRef<ScreenCapturePayload | undefined>(undefined);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    isRecordingRef.current = isRecording;
    startRecordingRef.current = startRecording;
    stopRecordingRef.current = stopRecording;
  });

  useEffect(() => {
    console.log('[clicky:orb] Recorder mounted and waiting for push-to-talk recording start');
    const disposeStart = window.clicky.onRecordingStart(() => {
      console.log('[clicky:orb] recording start received', { isRecording: isRecordingRef.current });
      void startCommandRecording();
    });
    const disposeStop = window.clicky.onRecordingStop(() => {
      console.log('[clicky:orb] recording stop received', { isRecording: isRecordingRef.current });
      if (isRecordingRef.current) {
        void stopAndHandoff('hotkey-release');
      }
    });
    return () => {
      disposeStart();
      disposeStop();
    };
  }, []);

  async function stopAndHandoff(reason: string) {
    if (isStoppingRef.current) {
      console.log('[clicky:orb] stop ignored because handoff is already running', { reason });
      return;
    }
    isStoppingRef.current = true;
    console.log('[clicky:orb] stopping active recording', { reason });
    const audio = await stopRecordingRef.current();
    if (!audio) {
      console.warn('[clicky:orb] no audio payload returned; closing orb');
      window.close();
      return;
    }

    const settings = await window.clicky.getSettings();
    const captures = captureRef.current ? [captureRef.current] : [];
    captureRef.current = undefined;
    console.log('[clicky:orb] sending audio for Whisper transcription', {
      bytes: audio.bytes.byteLength,
      mimeType: audio.mimeType,
      captures: captures.length
    });

    try {
      const finalTranscript = await window.clicky.transcribeAudio(audio);
      console.log('[clicky:orb] Whisper transcription received', {
        chars: finalTranscript.length,
        transcript: finalTranscript
      });

      if (!finalTranscript.trim()) {
        console.warn('[clicky:orb] Whisper returned an empty transcript; closing orb');
        window.close();
        return;
      }

      const request = {
        transcript: finalTranscript.trim(),
        captures,
        model: settings.model,
        conversationHistory: []
      };

      console.log('[clicky:orb] spawning agent from transcript');
      await window.clicky.spawnAgent(request);
      console.log('[clicky:orb] agent spawn IPC completed');
    } catch (err) {
      console.error('[clicky:orb] Whisper transcription or agent spawn failed:', err);
      await window.clicky.spawnAgentError('Transcription Failed: Please check your OpenAI API key or internet connection');
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
    console.log('[clicky:orb] wake word handoff received; starting command recording');
    captureRef.current = undefined;
    try {
      console.log('[clicky:orb] capturing screen context before recording');
      const capture = await window.clicky.takeScreenshot();
      captureRef.current = capture;
      console.log('[clicky:orb] background screenshot captured', {
        label: capture.label,
        width: capture.width,
        height: capture.height
      });
    } catch (err) {
      console.error('[clicky:orb] background screenshot failed:', err);
    }
    console.log('[clicky:orb] starting microphone recording with silence auto-stop');
    await startRecordingRef.current({
      silenceMs: 2000,
      onSilence: () => {
        void stopAndHandoff('silence-timeout');
      }
    });
    console.log('[clicky:orb] microphone recording started');
  }

  return (
    <div className="listening-orb">
      <div className="orb-circle">
        <div className="waveform">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className="waveform-bar"
              style={{
                animationDelay: `${i * 0.12}s`,
                transform: `scaleY(${0.4 + level * 1.2})`
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
