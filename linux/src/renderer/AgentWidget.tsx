import { useCallback, useEffect, useRef, useState } from 'react';
import { formatAgentResponseForDisplay } from '../shared/formatAgentResponse';
import type { AgentState, ScreenCapturePayload } from '../shared/types';
import { playAudioBytes, stopAudioPlayback } from './playAudio';
import { RealtimeAgentSession } from './realtimeAgent';
import { useVoiceRecorder } from './useVoiceRecorder';

type ArrivalPhase = 'spawning' | 'materializing' | 'traveling' | 'settled';

export interface AgentWidgetProps {
  agentId: string;
  color?: string;
}

function inferToolType(command: string, transcript: string): { tone: 'blue' | 'green' | 'red'; label: string; activity: string } {
  const cmd = command.toLowerCase();
  const t = transcript.toLowerCase();

  if (cmd.includes('creating local files') || cmd.includes('writing /tmp/clicky_apps') || cmd.includes('write_file')) {
    return { tone: 'green', label: 'BUILDING APP', activity: 'Creating the local files' };
  }
  if (cmd.includes('opening generated website') || (cmd.includes('/tmp/clicky_apps') && (cmd.includes('xdg-open') || cmd.includes('python')))) {
    return { tone: 'green', label: 'LAUNCHING APP', activity: 'Opening the finished preview' };
  }
  if (cmd.includes('opening') && (cmd.includes('http') || cmd.includes('browser'))) {
    return { tone: 'blue', label: 'OPENING LINK', activity: 'Opening it in the browser' };
  }
  if (cmd.includes('opening')) {
    return { tone: 'green', label: 'OPENING FILE', activity: 'Opening the file' };
  }
  if (cmd.includes('downloading')) {
    return { tone: 'blue', label: 'DOWNLOADING FILE', activity: 'Downloading the attachment' };
  }
  if (cmd.includes('reading')) {
    return { tone: 'blue', label: 'READING FILE', activity: 'Reading the attachment' };
  }
  if (cmd.includes('checking email') || cmd.includes('fetching recent emails')) {
    return { tone: 'blue', label: 'CHECKING EMAIL', activity: 'Checking recent messages' };
  }
  if (cmd.includes('reading website') || cmd.includes('scraping')) {
    return { tone: 'blue', label: 'SCRAPING WEB', activity: 'Reading the web page' };
  }
  if (cmd.includes('updating local files')) {
    return { tone: 'green', label: 'UPDATING FILES', activity: 'Updating local files' };
  }
  if (cmd.includes('running project task')) {
    return { tone: 'green', label: 'RUNNING TASK', activity: 'Running the project task' };
  }
  if (cmd.includes('running local script')) {
    return { tone: 'green', label: 'RUNNING SCRIPT', activity: 'Running the local script' };
  }
  if (cmd.includes('working locally')) {
    return { tone: 'green', label: 'WORKING LOCALLY', activity: 'Working on your machine' };
  }
  if (
    cmd.includes('ls') ||
    cmd.includes('cd') ||
    cmd.includes('mkdir') ||
    cmd.includes('rm') ||
    cmd.includes('cp') ||
    cmd.includes('mv') ||
    cmd.includes('git') ||
    cmd.includes('npm') ||
    cmd.includes('pip') ||
    cmd.includes('python') ||
    cmd.includes('node') ||
    cmd.includes('sed') ||
    cmd.includes('cat') ||
    cmd.includes('grep') ||
    cmd.includes('curl') ||
    cmd.includes('wget')
  ) {
    return { tone: 'green', label: 'WORKING LOCALLY', activity: 'Working on your machine' };
  }
  if (t.includes('search') || t.includes('google') || t.includes('find') || t.includes('look up') || t.includes('web')) {
    return { tone: 'blue', label: 'SEARCHING WEB', activity: 'Looking up the information' };
  }
  if (t.includes('reminder') || t.includes('calendar') || t.includes('schedule') || t.includes('event')) {
    return { tone: 'red', label: 'UPDATING CALENDAR', activity: 'Updating your schedule' };
  }
  if (t.includes('file') || t.includes('folder') || t.includes('desktop') || t.includes('document') || t.includes('directory')) {
    return { tone: 'green', label: 'WORKING WITH FILES', activity: 'Handling the file task' };
  }
  if (t.includes('email') || t.includes('mail') || t.includes('message') || t.includes('slack')) {
    return { tone: 'blue', label: 'CHECKING MESSAGES', activity: 'Checking your messages' };
  }
  return { tone: 'green', label: 'WORKING', activity: 'Working on it' };
}

function truncateCaption(s: string, max: number): string {
  const t = s.trim();
  if (!t.length) return '';
  if (t.length <= max) return t;
  const budget = Math.max(8, max - 1);
  const cut = t.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.45 ? cut.slice(0, lastSpace).trimEnd() : cut.trimEnd();
  return `${base}…`;
}

export function AgentWidget({ agentId, color }: AgentWidgetProps) {
  const [agent, setAgent] = useState<AgentState | undefined>();
  const [error, setError] = useState('');
  const [flashCommand, setFlashCommand] = useState('');
  const [followUpMode, setFollowUpMode] = useState<'none' | 'text' | 'voice'>('none');
  const [followUpText, setFollowUpText] = useState('');
  const [isTerminalVisible, setIsTerminalVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDetailsVisible, setIsDetailsVisible] = useState(false);
  const [arrivalPhase, setArrivalPhase] = useState<ArrivalPhase>('spawning');
  const hasArrivedRef = useRef(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const realtimeFinalTranscriptRef = useRef('');
  const realtimeAgentRef = useRef<RealtimeAgentSession | undefined>(undefined);
  const realtimeStartPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const realtimeStartedAgentIdRef = useRef<string | undefined>(undefined);
  const legacyFallbackStartedRef = useRef(false);
  const agentRef = useRef<AgentState | undefined>(undefined);
  const { transcript, level, isRecording, startRecording, stopRecording } = useVoiceRecorder();

  const startRealtimeAgent = useCallback(async (state?: AgentState) => {
    const current = state ?? agentRef.current;
    if (!current || current.model !== 'gpt-realtime-2') return;
    if (realtimeAgentRef.current || realtimeStartPromiseRef.current || realtimeStartedAgentIdRef.current === current.id) {
      console.log('[clicky:realtime-agent] duplicate start suppressed', {
        agentId,
        hasSession: !!realtimeAgentRef.current,
        hasStartPromise: !!realtimeStartPromiseRef.current,
        startedAgentId: realtimeStartedAgentIdRef.current
      });
      return;
    }
    realtimeStartedAgentIdRef.current = current.id;
    const session = new RealtimeAgentSession({
      agentId,
      initialState: current,
      onState: (next) => {
        agentRef.current = next;
        setAgent(next);
        window.clicky.reportAgentState(next, 'realtime-state');
      },
      onError: setError
    });
    realtimeAgentRef.current = session;
    const startPromise = session.start()
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[clicky:realtime-agent] start failed', { agentId, message });
        session.close();
        realtimeAgentRef.current = undefined;
        if (!legacyFallbackStartedRef.current) {
          legacyFallbackStartedRef.current = true;
          const fallbackState = agentRef.current ?? current;
          const next = {
            ...fallbackState,
            displayHeader: 'Retrying',
            displayCaption: 'Switching to the standard agent path',
            summary: 'Switching to the standard agent path'
          };
          agentRef.current = next;
          setAgent(next);
          window.clicky.reportAgentState(next, 'realtime-start-fallback');
          return window.clicky.followUp(agentId, {
            transcript: fallbackState.transcript,
            captures: fallbackState.captures,
            model: 'gpt-5.4-mini',
            conversationHistory: fallbackState.conversationHistory,
            agentId
          }).catch((fallbackErr) => {
            const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            setError(fallbackMessage || message);
            setAgent((prev) => prev ? { ...prev, status: 'error', error: fallbackMessage || message, completedAt: Date.now() } : prev);
          });
        }
        setError(message);
        setAgent((prev) => prev ? { ...prev, status: 'error', error: message, completedAt: Date.now() } : prev);
        realtimeStartedAgentIdRef.current = undefined;
        return undefined;
      })
      .finally(() => {
        if (realtimeStartPromiseRef.current === startPromise) {
          realtimeStartPromiseRef.current = undefined;
        }
      });
    realtimeStartPromiseRef.current = startPromise;
    await startPromise;
  }, [agentId]);

  useEffect(() => {
    void window.clicky.getAgentState(agentId).then((state) => {
      if (!state) return;
      agentRef.current = state;
      setAgent(state);
      if (state.model === 'gpt-realtime-2' && state.status === 'running') {
        void startRealtimeAgent(state);
      }
    });

    const disposers = [
      window.clicky.onAgentUpdate((state) => {
        if (state.id === agentId) {
          agentRef.current = state;
          setAgent(state);
          if (state.model === 'gpt-realtime-2' && state.status === 'running') {
            void startRealtimeAgent(state);
          }
        }
      }),
      window.clicky.onChatError((message) => {
        setError(message);
      }),
      window.clicky.onTtsAudio(playAudioBytes),
      window.clicky.onTtsStop(stopAudioPlayback),
      window.clicky.onTtsError(setError),
      window.clicky.onAgentCommandFlash((command) => {
        setFlashCommand(command);
        if (flashTimeoutRef.current) {
          clearTimeout(flashTimeoutRef.current);
        }
        flashTimeoutRef.current = setTimeout(() => {
          setFlashCommand('');
        }, 2500);
      })
    ];
    return () => {
      disposers.forEach((dispose) => dispose());
      if (flashTimeoutRef.current) {
        clearTimeout(flashTimeoutRef.current);
      }
      realtimeAgentRef.current?.close();
    };
  }, [agentId, startRealtimeAgent]);

  useEffect(() => {
    const stopRealtime = () => {
      void realtimeAgentRef.current?.stopAndRespond();
    };

    const disposers = [
      window.clicky.onRecordingStart(() => void startRealtimeAgent()),
      window.clicky.onRecordingStop(stopRealtime)
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [startRealtimeAgent]);

  useEffect(() => {
    if (agent?.model === 'gpt-realtime-2' && agent.status === 'running') {
      void startRealtimeAgent(agent);
    }
  }, [agent?.model, agent?.status, startRealtimeAgent]);

  useEffect(() => {
    if (hasArrivedRef.current) return;
    hasArrivedRef.current = true;

    setArrivalPhase('spawning');

    const materializeTimer = setTimeout(() => {
      setArrivalPhase('materializing');
    }, 400);

    const settleTimer = setTimeout(() => {
      setArrivalPhase('settled');
    }, 900);

    return () => {
      clearTimeout(materializeTimer);
      clearTimeout(settleTimer);
    };
  }, []);

  const status = agent?.status ?? 'running';
  const isDone = status === 'done';
  const isError = status === 'error';

  const latestCommand = agent?.commands?.[agent.commands.length - 1] ?? '';
  const activeCommand = flashCommand || latestCommand;

  useEffect(() => {
    if (status === 'running') {
      if (activeCommand) {
        setIsTerminalVisible(true);
      }
    } else if (status === 'done') {
      const timer = setTimeout(() => setIsTerminalVisible(false), 300);
      return () => clearTimeout(timer);
    } else {
      setIsTerminalVisible(false);
    }
  }, [status, activeCommand]);

  let captionDisplay = '';
  if (isDone && agent) {
    if (agent.displayCaption.trim()) {
      captionDisplay = formatAgentResponseForDisplay(agent.displayCaption);
    } else {
      const spokenStyled = agent.response ? formatAgentResponseForDisplay(agent.response) : '';
      captionDisplay = spokenStyled ? truncateCaption(spokenStyled, 160) : '';
    }
  }
  const displayDetails = isDone && agent?.displayDetails?.length ? agent.displayDetails : [];

  const closeWidget = useCallback(() => {
    void window.clicky.closeAgent(agentId);
  }, [agentId]);

  const submitFollowUp = useCallback(async () => {
    if (!agent) return;
    let text = followUpText;
    if (followUpMode === 'voice') {
      const audio = await stopRecording();
      const realtimeTranscript = realtimeFinalTranscriptRef.current;
      realtimeFinalTranscriptRef.current = '';

      if (realtimeTranscript) {
        text = realtimeTranscript;
      } else if (audio) {
        try {
          text = await window.clicky.transcribeAudio(audio);
        } catch (err) {
          setError('Transcription Failed: Please check your OpenAI API key or internet connection');
          return;
        }
      }
    }
    if (!text.trim()) return;

    const captures: ScreenCapturePayload[] = [];
    try {
      captures.push(await window.clicky.captureSelectedScreen());
    } catch {
      void 0;
    }

    setError('');
    setFollowUpMode('none');
    setFollowUpText('');

    await window.clicky.followUp(agentId, {
      transcript: text.trim(),
      captures,
      model: agent.model,
      conversationHistory: agent.conversationHistory,
      agentId
    });
  }, [agent, agentId, followUpMode, followUpText, stopRecording]);

  const startVoiceFollowUp = useCallback(async () => {
    setFollowUpMode('voice');
    realtimeFinalTranscriptRef.current = '';

    try {
      await startRecording({
        silenceMs: 2000,
        useRealtime: true,
        onSilence: () => {
          void submitFollowUp();
        },
        onFinalTranscript: (text) => {
          realtimeFinalTranscriptRef.current = text;
          void submitFollowUp();
        },
        onRealtimeError: (message) => {
          console.error('[clicky:agent] realtime transcription error:', message);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[clicky:agent] voice follow-up start failed', { agentId, message });
      setError(message || 'Microphone access failed');
      setFollowUpMode('none');
    }
  }, [agentId, startRecording, submitFollowUp]);

  const stopVoiceFollowUp = useCallback(async () => {
    await stopRecording();
    setFollowUpMode('none');
  }, [stopRecording]);

  const handleTextKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitFollowUp();
    }
  }, [submitFollowUp]);

  const tool = inferToolType(activeCommand, agent?.transcript ?? '');

  const doneShellTitleRaw =
    agent?.displayHeader?.trim()
      ? formatAgentResponseForDisplay(agent.displayHeader)
      : agent?.displayCaption?.trim()
        ? formatAgentResponseForDisplay(agent.displayCaption)
        : '';

  const expandWidget = useCallback(() => {
    setIsExpanded(true);
    void window.clicky.setAgentExpanded(agentId, true);
  }, [agentId]);

  const collapseModal = useCallback(() => {
    if (followUpMode !== 'none') return;
    setIsExpanded(false);
    void window.clicky.setAgentExpanded(agentId, false);
  }, [agentId, followUpMode]);

  useEffect(() => {
    setIsDetailsVisible(false);
  }, [agentId, status, agent?.displayCaption]);

  const modalTitle =
    status === 'running'
      ? tool.label
      : isDone
        ? truncateCaption(doneShellTitleRaw || tool.label, 52).trim() || tool.label
        : status === 'error'
          ? 'Error'
          : (agent?.transcript?.trim() || 'Agent');
  const modalTitleDisplay =
    modalTitle.length > 46 ? `${modalTitle.slice(0, 45).toUpperCase()}…` : modalTitle.toUpperCase();

  const statusPillLabel = isError ? 'Error' : isDone ? 'Done' : 'Working';

  const arrivalClass = arrivalPhase === 'settled' ? 'phase-settled' : `phase-${arrivalPhase}`;

  return (
    <div
      className={`agent-widget ${isExpanded ? 'expanded' : 'minimized'} ${isError ? 'status-error' : isDone ? 'status-done' : 'status-running'} ${arrivalClass}`}
      style={{ '--agent-color': color ?? '#34C759' } as React.CSSProperties}
    >
      <button type="button" className="agent-mini" onClick={expandWidget} aria-label="Open agent details">
        <span className={`mini-status ${status}`} />
        <span className="arrival-spinner" />
        <span className="mini-triangle-wrapper">
          <span className="mini-triangle" />
        </span>
      </button>

      <header className="agent-header">
        <h2 className="agent-modal-title" title={modalTitle}>
          {modalTitleDisplay}
        </h2>
        <div className="agent-header-actions">
          <span className={`status-pill ${status}`}>{statusPillLabel}</span>
          <button type="button" className="agent-minimize" onClick={collapseModal} aria-label="Minimize">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button type="button" className="agent-close" onClick={closeWidget} aria-label="Close agent">
            &times;
          </button>
        </div>
      </header>

      <section className="agent-body" aria-hidden={!isExpanded}>
        {isDone && captionDisplay && (
          <p className="agent-modal-lead">{captionDisplay}</p>
        )}

        {displayDetails.length > 0 && (
          <div className="agent-display-details">
            <button
              type="button"
              className="details-toggle"
              onClick={() => setIsDetailsVisible((visible) => !visible)}
              aria-expanded={isDetailsVisible}
            >
              {isDetailsVisible ? 'Hide details' : 'View details'}
            </button>
            {isDetailsVisible && (
              <dl className="details-list">
                {displayDetails.map((detail) => (
                  <div key={`${detail.label}:${detail.value}`} className="details-row">
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}

        {status === 'running' && (
          <div className="agent-transcript">
            <span className="modal-section-label">Command</span>
            <p>{agent?.transcript ?? 'Initializing...'}</p>
          </div>
        )}

        {(status === 'running' || isTerminalVisible) && activeCommand && (
          <div key={tool.activity} className={`tool-activity-card tone-${tool.tone} ${status !== 'running' ? 'fade-out' : ''}`}>
            <span className="tool-loader" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <div className="tool-activity-copy">
              <span className="tool-activity-kicker">In progress</span>
              <p>{tool.activity}</p>
            </div>
          </div>
        )}

        {isError && (
          <div className="agent-error">
            <span className="modal-section-label">Error</span>
            <div className="error-badge">{error || agent?.error}</div>
          </div>
        )}

      </section>

      {followUpMode === 'voice' && (
        <section className="follow-up-recording">
          <div className="meter" aria-label="Audio level">
            <span style={{ width: `${level * 100}%` }} />
          </div>
          <p>{isRecording ? (transcript || 'Listening...') : 'Starting microphone...'}</p>
          <div className="follow-up-buttons">
            <button onClick={() => void submitFollowUp()} disabled={!isRecording && !transcript.trim()}>
              Send
            </button>
            <button onClick={() => void stopVoiceFollowUp()}>Cancel</button>
          </div>
        </section>
      )}

      {followUpMode === 'text' && (
        <section className="follow-up-text">
          <textarea
            value={followUpText}
            onChange={(e) => setFollowUpText(e.target.value)}
            onKeyDown={handleTextKeyDown}
            placeholder="Type follow-up..."
            rows={2}
          />
          <div className="follow-up-buttons">
            <button onClick={() => void submitFollowUp()}>Send</button>
            <button onClick={() => setFollowUpMode('none')}>Cancel</button>
          </div>
        </section>
      )}

      {isDone && followUpMode === 'none' && (
        <footer className="agent-footer">
          <div className="follow-up-section">
            <span className="follow-up-label">Follow up</span>
            <div className="follow-up-buttons-row">
              <button type="button" className="follow-up-btn text-btn" onClick={() => setFollowUpMode('text')}>
                <svg className="follow-up-btn-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 7h12M4 12h8M4 17h14" />
                  <path d="M16 3v4M18 5h-4" />
                </svg>
                Text
              </button>
              <button type="button" className="follow-up-btn voice-btn" onClick={() => void startVoiceFollowUp()}>
                <svg className="follow-up-btn-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="3" width="6" height="10" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 19v3" />
                </svg>
                Voice
              </button>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
