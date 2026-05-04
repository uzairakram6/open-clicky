import { useCallback, useEffect, useRef, useState } from 'react';
import { stripPointTags } from '../shared/pointTags';
import type { AgentState, AgentAction, ScreenCapturePayload } from '../shared/types';
import { playAudioBytes } from './playAudio';
import { useVoiceRecorder } from './useVoiceRecorder';

export interface AgentWidgetProps {
  agentId: string;
}

function inferToolType(command: string, transcript: string): { tone: 'blue' | 'green' | 'red'; label: string } {
  const cmd = command.toLowerCase();
  const t = transcript.toLowerCase();

  if (cmd.includes('writing /tmp/clicky_apps') || cmd.includes('write_file')) {
    return { tone: 'green', label: 'BUILDING APP' };
  }
  if (cmd.includes('/tmp/clicky_apps') && (cmd.includes('xdg-open') || cmd.includes('python'))) {
    return { tone: 'green', label: 'LAUNCHING APP' };
  }
  if (cmd.includes('opening') && (cmd.includes('http') || cmd.includes('browser'))) {
    return { tone: 'blue', label: 'OPENING LINK' };
  }
  if (cmd.includes('scraping')) {
    return { tone: 'blue', label: 'SCRAPING WEB' };
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
    return { tone: 'green', label: 'EXECUTING COMMAND' };
  }
  if (t.includes('search') || t.includes('google') || t.includes('find') || t.includes('look up') || t.includes('web')) {
    return { tone: 'blue', label: 'SEARCHING WEB' };
  }
  if (t.includes('reminder') || t.includes('calendar') || t.includes('schedule') || t.includes('event')) {
    return { tone: 'red', label: 'UPDATING CALENDAR' };
  }
  if (t.includes('file') || t.includes('folder') || t.includes('desktop') || t.includes('document') || t.includes('directory')) {
    return { tone: 'green', label: 'ORGANIZING FILES' };
  }
  if (t.includes('email') || t.includes('mail') || t.includes('message') || t.includes('slack')) {
    return { tone: 'blue', label: 'CHECKING MESSAGES' };
  }
  return { tone: 'green', label: 'WORKING' };
}

export function AgentWidget({ agentId }: AgentWidgetProps) {
  const [agent, setAgent] = useState<AgentState | undefined>();
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [flashCommand, setFlashCommand] = useState('');
  const [followUpMode, setFollowUpMode] = useState<'none' | 'text' | 'voice'>('none');
  const [followUpText, setFollowUpText] = useState('');
  const [isTerminalVisible, setIsTerminalVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { transcript, level, isRecording, startRecording, stopRecording } = useVoiceRecorder();

  useEffect(() => {
    const disposers = [
      window.clicky.onAgentUpdate((state) => {
        if (state.id === agentId) {
          setAgent(state);
        }
      }),
      window.clicky.onChatChunk((text) => {
        setResponse((current) => stripPointTags(`${current}${text}`));
      }),
      window.clicky.onChatDone(() => {
        setResponse((current) => {
          const clean = stripPointTags(current);
          return clean;
        });
      }),
      window.clicky.onChatError((message) => {
        setError(message);
      }),
      window.clicky.onTtsAudio(playAudioBytes),
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
    };
  }, [agentId]);

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

  const handleAction = useCallback((action: AgentAction) => {
    if (action.type === 'copy' && agent?.response) {
      void navigator.clipboard.writeText(agent.response);
    } else {
      void window.clicky.runAgentAction(action);
    }
  }, [agent]);

  const closeWidget = useCallback(() => {
    void window.clicky.closeAgent(agentId);
  }, [agentId]);

  const submitFollowUp = useCallback(async () => {
    if (!agent) return;
    let text = followUpText;
    if (followUpMode === 'voice') {
      const audio = await stopRecording();
      if (!audio) return;
      try {
        text = await window.clicky.transcribeAudio(audio);
      } catch (err) {
        setError('Transcription Failed: Please check your OpenAI API key or internet connection');
        return;
      }
    }
    if (!text.trim()) return;

    const captures: ScreenCapturePayload[] = [];
    try {
      captures.push(await window.clicky.captureSelectedScreen());
    } catch {
      void 0;
    }

    setResponse('');
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
    setResponse('');
    await startRecording({
      silenceMs: 2000,
      onSilence: () => {
        void submitFollowUp();
      }
    });
  }, [startRecording, submitFollowUp]);

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

  const expandWidget = useCallback(() => {
    setIsExpanded(true);
    void window.clicky.setAgentExpanded(agentId, true);
  }, [agentId]);

  const collapseModal = useCallback(() => {
    if (followUpMode !== 'none') return;
    setIsExpanded(false);
    void window.clicky.setAgentExpanded(agentId, false);
  }, [agentId, followUpMode]);

  const modalTitle =
    status === 'running'
      ? tool.label
      : (agent?.transcript?.trim() || 'Agent');
  const modalTitleDisplay =
    modalTitle.length > 46 ? `${modalTitle.slice(0, 45).toUpperCase()}…` : modalTitle.toUpperCase();

  const statusPillLabel = isError ? 'Error' : isDone ? 'Done' : 'Working';

  return (
    <div
      className={`agent-widget ${isExpanded ? 'expanded' : 'minimized'} ${isError ? 'status-error' : ''}`}
    >
      <button type="button" className="agent-mini" onClick={expandWidget} aria-label="Open agent details">
        <span className={`mini-status ${status}`} />
        <span className="mini-triangle" />
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
        {isDone && (agent?.summary || agent?.response) && (
          <p className="agent-modal-lead">{agent.summary || agent.response}</p>
        )}

        {isDone && agent?.transcript && (
          <div className="agent-modal-meta">
            <span className="modal-section-label">Request</span>
            <p>{agent.transcript}</p>
          </div>
        )}

        {status === 'running' && (
          <div className="agent-transcript">
            <span className="modal-section-label">Command</span>
            <p>{agent?.transcript ?? 'Initializing...'}</p>
          </div>
        )}

        {(status === 'running' || isTerminalVisible) && activeCommand && (
          <div key={activeCommand} className={`terminal-box ${status !== 'running' ? 'fade-out' : ''}`}>
            <span className="terminal-text">{`> ${activeCommand}`}</span>
            <span className="cursor-blink">█</span>
          </div>
        )}

        {isError && (
          <div className="agent-error">
            <span className="modal-section-label">Error</span>
            <div className="error-badge">{error || agent?.error}</div>
          </div>
        )}

        {isDone && agent?.actions && agent.actions.length > 0 && (
          <div className="agent-suggested">
            <span className="modal-section-label">Suggested next</span>
            <div className="agent-actions">
              {agent.actions.map((action) => (
                <button key={action.id} type="button" className="action-pill" onClick={() => handleAction(action)}>
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {followUpMode === 'voice' && isRecording && (
        <section className="follow-up-recording">
          <div className="meter" aria-label="Audio level">
            <span style={{ width: `${level * 100}%` }} />
          </div>
          <p>{transcript || 'Listening...'}</p>
          <div className="follow-up-buttons">
            <button onClick={() => void submitFollowUp()}>Send</button>
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
