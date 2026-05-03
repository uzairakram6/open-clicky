import { useCallback, useEffect, useRef, useState } from 'react';
import { stripPointTags } from '../shared/pointTags';
import type { AgentState, AgentAction, ConversationMessage, ScreenCapturePayload } from '../shared/types';
import { playAudioBytes } from './playAudio';
import { useVoiceRecorder } from './useVoiceRecorder';

export interface AgentWidgetProps {
  agentId: string;
}

function inferToolType(command: string, transcript: string): { icon: string; label: string } {
  const cmd = command.toLowerCase();
  const t = transcript.toLowerCase();

  if (cmd.includes('opening') && (cmd.includes('http') || cmd.includes('browser'))) {
    return { icon: '\uD83C\uDF10', label: 'OPEN LINK' };
  }
  if (cmd.includes('scraping')) {
    return { icon: '\uD83E\uDDFE', label: 'WEB SCRAPE' };
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
    return { icon: '\uD83D\uDDA5\uFE0F', label: 'TERMINAL' };
  }
  if (t.includes('search') || t.includes('google') || t.includes('find') || t.includes('look up') || t.includes('web')) {
    return { icon: '\uD83C\uDF10', label: 'WEB SEARCH' };
  }
  if (t.includes('reminder') || t.includes('calendar') || t.includes('schedule') || t.includes('event')) {
    return { icon: '\uD83D\uDCC5', label: 'CALENDAR' };
  }
  if (t.includes('file') || t.includes('folder') || t.includes('desktop') || t.includes('document') || t.includes('directory')) {
    return { icon: '\uD83D\uDCC1', label: 'FILES' };
  }
  if (t.includes('email') || t.includes('mail') || t.includes('message') || t.includes('slack')) {
    return { icon: '\u2709\uFE0F', label: 'MESSAGES' };
  }
  return { icon: '\uD83E\uDD16', label: 'AGENT' };
}

export function AgentWidget({ agentId }: AgentWidgetProps) {
  const [agent, setAgent] = useState<AgentState | undefined>();
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [flashCommand, setFlashCommand] = useState('');
  const [followUpMode, setFollowUpMode] = useState<'none' | 'text' | 'voice'>('none');
  const [followUpText, setFollowUpText] = useState('');
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

  const status = agent?.status ?? 'running';
  const isDone = status === 'done';
  const isError = status === 'error';

  const latestCommand = agent?.commands?.[agent.commands.length - 1] ?? '';
  const activeCommand = flashCommand || latestCommand;
  const tool = inferToolType(activeCommand, agent?.transcript ?? '');

  const headerLabel = status === 'running'
    ? `${tool.icon} ${tool.label}`
    : (agent?.transcript ? agent.transcript.slice(0, 30) + (agent.transcript.length > 30 ? '...' : '') : 'Agent');

  return (
    <div className="agent-widget">
      <header className="agent-header">
        <div className="agent-title">
          <span className={`status-dot ${status}`} />
          <span className="agent-label">{headerLabel}</span>
        </div>
        <button className="agent-close" onClick={closeWidget} aria-label="Close">&times;</button>
      </header>

      <section className="agent-body">
        <div className="agent-transcript">
          <strong>Command</strong>
          <p>{agent?.transcript ?? 'Initializing...'}</p>
        </div>

        {status === 'running' && (
          <>
            {activeCommand && (
              <div className="command-flash">
                <div className="command-label">Action Feedback</div>
                <code>{`> ${activeCommand}`}</code>
              </div>
            )}
            <div className="agent-status running">
              <span className="status-indicator" />
              <span>
                {activeCommand
                  ? (activeCommand.toLowerCase().includes('opening') && activeCommand.toLowerCase().includes('browser')
                      ? 'Opening link in browser...'
                      : activeCommand.toLowerCase().includes('scraping')
                        ? 'Scraping website...'
                        : 'Executing shell command...')
                  : 'Running'}
              </span>
            </div>
          </>
        )}

        {response && status !== 'done' && (
          <div className="agent-response">
            <strong>Response</strong>
            <p>{response}</p>
          </div>
        )}

        {isDone && (
          <div className="agent-done">
            <div className="done-badge">Done</div>
            <p className="agent-summary">{agent?.summary}</p>
          </div>
        )}

        {isError && (
          <div className="agent-error">
            <strong>Error</strong>
            <div className="error-badge">{error || agent?.error}</div>
          </div>
        )}

        {isDone && agent?.actions && agent.actions.length > 0 && (
          <div className="agent-actions">
            {agent.actions.map((action) => (
              <button key={action.id} className="action-pill" onClick={() => handleAction(action)}>
                {action.label}
              </button>
            ))}
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
              <button className="follow-up-btn text-btn" onClick={() => setFollowUpMode('text')}>
                Text
              </button>
              <button className="follow-up-btn voice-btn" onClick={() => void startVoiceFollowUp()}>
                Voice
              </button>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
