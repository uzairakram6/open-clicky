import type { AgentState, ScreenCapturePayload } from '../shared/types';
import { stopAudioPlayback } from './playAudio';

export interface RealtimeAgentSessionOptions {
  agentId: string;
  initialState: AgentState;
  onState: (state: AgentState) => void;
  onError: (message: string) => void;
}

type RealtimeEvent = {
  type?: string;
  delta?: string;
  output_index?: number;
  name?: string;
  call_id?: string;
  arguments?: string;
  transcript?: string;
  response?: {
    output?: Array<{
      type?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      content?: Array<{ type?: string; transcript?: string; text?: string }>;
    }>;
  };
  item?: {
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  error?: { message?: string };
};

function logRealtime(message: string, details?: unknown): void {
  console.log(`[clicky:realtime-agent] ${message}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`);
}

export class RealtimeAgentSession {
  private pc?: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private stream?: MediaStream;
  private audio?: HTMLAudioElement;
  private state: AgentState;
  private responseText = '';
  private finalTranscript = '';
  private screenshotAttached = false;
  private stopped = false;
  private pendingToolCalls = new Map<number, { callId: string; name: string; arguments: string }>();
  private emailFallbackAttempted = false;
  private emailToolSatisfied = false;
  private fileCleanupFallbackAttempted = false;
  private fileCleanupToolSatisfied = false;
  private suppressAudioUntilToolResult = false;
  private toolPreambleSpoken = false;
  private responseDeltaLogBuffer = '';
  private responseDeltaLogTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: RealtimeAgentSessionOptions) {
    this.state = { ...options.initialState };
  }

  async start(): Promise<void> {
    logRealtime('starting session', {
      agentId: this.options.agentId,
      transcriptChars: this.state.transcript.length,
      captures: this.state.captures.length
    });
    this.suppressAudioUntilToolResult = shouldRequireToolBeforeSpeaking(this.state.transcript);
    if (this.suppressAudioUntilToolResult) {
      this.patchState(this.progressPatchForTranscript(this.state.transcript));
    }
    this.reportLog('realtime_session_start', {
      transcript: this.state.transcript,
      suppressAudioUntilToolResult: this.suppressAudioUntilToolResult
    });
    this.pc = new RTCPeerConnection();
    this.dataChannel = this.pc.createDataChannel('oai-events');
    this.dataChannel.addEventListener('message', (event) => void this.handleMessage(event));
    this.dataChannel.addEventListener('error', () => this.fail('Realtime data channel failed'));

    this.pc.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      this.audio ??= new Audio();
      this.audio.autoplay = true;
      this.audio.muted = this.suppressAudioUntilToolResult;
      this.audio.srcObject = stream;
      void this.audio.play().catch(() => undefined);
    });

    this.stream = await this.getSilentAudioStream();
    for (const track of this.stream.getAudioTracks()) {
      this.pc.addTrack(track, this.stream);
    }

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    logRealtime('local offer created', {
      agentId: this.options.agentId,
      sdpChars: offer.sdp?.length ?? 0
    });
    const answer = await window.clicky.createRealtimeAgentCall(offer.sdp ?? '');
    logRealtime('remote answer received', {
      agentId: this.options.agentId,
      sdpChars: answer.answerSdp.length
    });
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.answerSdp });

    await this.waitForConnected();
    logRealtime('WebRTC connected', { agentId: this.options.agentId });
    await this.waitForDataChannelOpen();
    logRealtime('data channel open', { agentId: this.options.agentId });
    this.patchState({ displayHeader: 'Thinking', summary: 'Processing...' });
    this.sendInitialUserMessage();
    this.send(this.createInitialResponseRequest());
    logRealtime('response.create sent', { agentId: this.options.agentId });
  }

  async stopAndRespond(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
    this.send({ type: 'input_audio_buffer.commit' });
    await this.attachScreenshotIfUseful();
    this.patchState({ displayHeader: 'Thinking', summary: 'Processing...' });
    this.send({ type: 'response.create' });
  }

  close(): void {
    this.flushResponseDeltaLog();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.dataChannel?.close();
    this.pc?.close();
    if (this.audio) {
      this.audio.srcObject = null;
    }
  }

  private async handleMessage(event: MessageEvent<string>): Promise<void> {
    let payload: RealtimeEvent;
    try {
      payload = JSON.parse(event.data) as RealtimeEvent;
    } catch {
      this.fail('Malformed Realtime message');
      return;
    }

    if (payload.type === 'conversation.item.input_audio_transcription.delta' && payload.delta) {
      this.patchState({ transcript: `${this.state.transcript}${payload.delta}` });
      return;
    }

    if (payload.type === 'conversation.item.input_audio_transcription.completed' && payload.transcript) {
      this.finalTranscript = payload.transcript;
      this.reportLog('realtime_user_transcript_completed', { transcript: payload.transcript });
      this.patchState({ transcript: payload.transcript });
      return;
    }

    if (isResponseTextDelta(payload.type) && payload.delta) {
      this.responseText += payload.delta;
      this.bufferResponseDeltaLog(payload.type ?? 'response.delta', payload.delta);
      if (this.suppressAudioUntilToolResult) {
        this.reportLog('realtime_response_blocked_until_tool', {
          source: payload.type,
          delta: this.clip(payload.delta, 500),
          accumulatedResponse: this.clip(this.responseText, 1200)
        });
        this.patchState(this.progressPatchForTranscript(this.finalTranscript || this.state.transcript));
        return;
      }
      this.patchState({
        displayHeader: 'Responding',
        displayCaption: this.clip(this.responseText, 160),
        response: this.responseText,
        summary: this.clip(this.responseText, 200)
      });
      return;
    }

    if (payload.type === 'response.function_call_arguments.delta' && payload.delta) {
      const index = payload.output_index ?? 0;
      const current = this.pendingToolCalls.get(index) ?? { callId: payload.call_id ?? '', name: payload.name ?? '', arguments: '' };
      const toolName = payload.name ?? current.name;
      this.pendingToolCalls.set(index, {
        callId: payload.call_id ?? current.callId,
        name: toolName,
        arguments: `${current.arguments}${payload.delta}`
      });
      this.speakRealtimePreambleIfSafe(toolName);
      return;
    }

    if (payload.type === 'response.function_call_arguments.done') {
      const index = payload.output_index ?? 0;
      const current = this.pendingToolCalls.get(index) ?? { callId: payload.call_id ?? '', name: payload.name ?? '', arguments: '' };
      this.pendingToolCalls.set(index, {
        callId: payload.call_id ?? current.callId,
        name: payload.name ?? current.name,
        arguments: payload.arguments ?? current.arguments
      });
      this.speakRealtimePreambleIfSafe(payload.name ?? current.name);
      return;
    }

    if (payload.type === 'response.done') {
      logRealtime('response.done received', payload);
      this.flushResponseDeltaLog();
      const calls = this.extractToolCalls(payload);
      const donePayloadTranscript = extractTranscriptFromDonePayload(payload);
      this.reportLog('realtime_response_done', {
        responseText: this.clip(this.responseText, 1200),
        donePayloadTranscript: this.clip(donePayloadTranscript, 1200),
        toolCalls: calls.map((call) => ({ name: call.name, arguments: this.clip(call.arguments, 1200) })),
        suppressAudioUntilToolResult: this.suppressAudioUntilToolResult
      });
      if (calls.length > 0) {
        this.speakRealtimePreambleIfSafe(calls[0]?.name ?? '');
        await this.runToolCalls(calls);
        return;
      }
      if (shouldForceEmailToolCall(this.finalTranscript || this.state.transcript) && !this.emailFallbackAttempted && !this.emailToolSatisfied) {
        this.speakRealtimePreambleIfSafe('check_email');
        await this.runEmailToolFallback();
        return;
      }
      if (shouldForceFileCleanupToolCall(this.finalTranscript || this.state.transcript) && !this.fileCleanupFallbackAttempted && !this.fileCleanupToolSatisfied) {
        this.speakRealtimePreambleIfSafe('execute_bash_command');
        await this.runFileCleanupToolFallback();
        return;
      }
      let response = this.responseText.trim();
      if (!response) {
        response = donePayloadTranscript;
      }
      this.patchState({
        status: 'done',
        response,
        displayHeader: response ? this.clip(response, 48) : 'Done',
        displayCaption: response ? this.clip(response, 160) : 'Done.',
        summary: response ? this.clip(response, 200) : 'Done.',
        completedAt: Date.now(),
        conversationHistory: [
          ...this.state.conversationHistory,
          { role: 'user', content: this.finalTranscript || this.state.transcript },
          { role: 'assistant', content: response }
        ]
      });
      return;
    }

    if (payload.type === 'error') {
      console.error(`[clicky:realtime-agent] error event ${JSON.stringify(payload)}`);
      this.fail(payload.error?.message ?? JSON.stringify(payload.error ?? payload));
    }
  }

  private async runToolCalls(calls: Array<{ callId: string; name: string; arguments: string }>): Promise<void> {
    for (const call of calls) {
      logRealtime('executing tool call', {
        agentId: this.options.agentId,
        name: call.name
      });
      this.patchState(this.progressPatchForTool(call.name));
      this.reportLog('realtime_tool_call_renderer', {
        name: call.name,
        arguments: this.clip(call.arguments, 1200)
      });
      if (call.name === 'check_email') {
        this.emailToolSatisfied = true;
      }
      if (call.name === 'execute_bash_command' && shouldForceFileCleanupToolCall(this.finalTranscript || this.state.transcript)) {
        this.fileCleanupToolSatisfied = true;
      }
      const result = await window.clicky.executeRealtimeTool({
        agentId: this.options.agentId,
        name: call.name,
        arguments: call.arguments
      });
      this.reportLog('realtime_tool_result_renderer', {
        name: call.name,
        commandLabel: result.commandLabel,
        output: this.clip(result.output, 1200),
        kind: result.kind,
        done: result.done,
        userMessage: result.userMessage
      });
      if (result.done && result.kind === 'sideEffectOnly') {
        this.finishLocalToolCompletion(result.userMessage || result.output || 'Done.');
        return;
      }
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.callId,
          output: result.output
        }
      });
    }
    this.emailFallbackAttempted = false;
    this.responseText = '';
    this.suppressAudioUntilToolResult = false;
    this.toolPreambleSpoken = false;
    if (this.audio) {
      stopAudioPlayback();
      this.audio.muted = false;
      void this.audio.play().catch(() => undefined);
    }
    this.reportLog('realtime_audio_unmuted_after_tools');
    this.send({ type: 'response.create' });
  }

  private finishLocalToolCompletion(message: string): void {
    const clean = message.trim() || 'Done.';
    this.stopRemoteAudio('side-effect-tool-completed');
    this.responseText = '';
    this.suppressAudioUntilToolResult = false;
    this.toolPreambleSpoken = false;
    this.reportLog('realtime_side_effect_tool_completed', { message: clean });
    this.patchState({
      status: 'done',
      response: clean,
      displayHeader: this.clip(clean, 48),
      displayCaption: this.clip(clean, 160),
      summary: this.clip(clean, 200),
      completedAt: Date.now(),
      conversationHistory: [
        ...this.state.conversationHistory,
        { role: 'user', content: this.finalTranscript || this.state.transcript },
        { role: 'assistant', content: clean }
      ]
    });
  }

  private async runEmailToolFallback(): Promise<void> {
    this.emailFallbackAttempted = true;
    logRealtime('email fallback tool execution', { agentId: this.options.agentId });
    this.patchState(this.progressPatchForTool('check_email'));
    const result = await window.clicky.executeRealtimeTool({
      agentId: this.options.agentId,
      name: 'check_email',
      arguments: JSON.stringify({ count: 5 })
    });
    this.reportLog('realtime_email_fallback_result', {
      commandLabel: result.commandLabel,
      output: this.clip(result.output, 1200)
    });
    this.responseText = '';
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Here are the recent emails:\n${result.output}`
          }
        ]
      }
    });
    this.suppressAudioUntilToolResult = false;
    this.toolPreambleSpoken = false;
    if (this.audio) {
      stopAudioPlayback();
      this.audio.muted = false;
      void this.audio.play().catch(() => undefined);
    }
    this.reportLog('realtime_audio_unmuted_after_email_fallback');
    this.send({ type: 'response.create' });
  }

  private async runFileCleanupToolFallback(): Promise<void> {
    this.fileCleanupFallbackAttempted = true;
    this.patchState(this.progressPatchForTool('desktop_cleanup'));
    this.reportLog('realtime_file_cleanup_fallback_start', { transcript: this.finalTranscript || this.state.transcript });
    const command = [
      'set -e',
      'target="$HOME/Desktop"',
      'if [ ! -d "$target" ]; then',
      '  target="$HOME"',
      'fi',
      'matches=( -iname "*.doc" -o -iname "*.docx" -o -iname "*.xls" -o -iname "*.xlsx" -o -iname "*.pdf" )',
      'before=$(find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) | wc -l)',
      'if command -v gio >/dev/null 2>&1; then',
      '  find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) -print0 | xargs -0 -r gio trash',
      'else',
      '  trash="$HOME/.local/share/Trash/files"',
      '  mkdir -p "$trash"',
      '  while IFS= read -r -d "" f; do',
      '    mv -n "$f" "$trash/"',
      '  done < <(find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) -print0)',
      'fi',
      'after=$(find "$target" -maxdepth 1 -type f \\( "${matches[@]}" \\) | wc -l)',
      'echo "Target: $target"',
      'echo "Matching files before: $before"',
      'echo "Matching files remaining: $after"',
      'echo "Moved to trash: $((before - after))"'
    ].join('\n');
    const result = await window.clicky.executeRealtimeTool({
      agentId: this.options.agentId,
      name: 'execute_bash_command',
      arguments: JSON.stringify({ command })
    });
    this.reportLog('realtime_file_cleanup_fallback_result', {
      commandLabel: result.commandLabel,
      output: this.clip(result.output, 1200)
    });
    const finalResponse = buildFileCleanupFinalResponse(result.output);
    this.suppressAudioUntilToolResult = false;
    this.toolPreambleSpoken = false;
    this.stopRemoteAudio('file-cleanup-deterministic-final');
    stopAudioPlayback();
    this.responseText = '';
    this.reportLog('realtime_file_cleanup_deterministic_final', { response: finalResponse });
    this.patchState({
      status: 'done',
      response: finalResponse,
      displayHeader: this.clip(finalResponse, 48),
      displayCaption: this.clip(finalResponse, 160),
      summary: this.clip(finalResponse, 200),
      completedAt: Date.now(),
      conversationHistory: [
        ...this.state.conversationHistory,
        { role: 'user', content: this.finalTranscript || this.state.transcript },
        { role: 'assistant', content: finalResponse }
      ]
    });
    void window.clicky.speak(finalResponse, this.options.agentId).catch((error) => {
      this.reportLog('realtime_file_cleanup_tts_error', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private extractToolCalls(payload: RealtimeEvent): Array<{ callId: string; name: string; arguments: string }> {
    const calls: Array<{ callId: string; name: string; arguments: string }> = [];
    const seenCallIds = new Set<string>();
    const pushCall = (call: { callId: string; name: string; arguments: string }) => {
      if (seenCallIds.has(call.callId)) return;
      seenCallIds.add(call.callId);
      calls.push(call);
    };
    for (const call of this.pendingToolCalls.values()) {
      if (call.callId && call.name) {
        pushCall(call);
      }
    }
    this.pendingToolCalls.clear();
    for (const item of payload.response?.output ?? []) {
      if (item.type === 'function_call' && item.call_id && item.name) {
        pushCall({ callId: item.call_id, name: item.name, arguments: item.arguments ?? '{}' });
      }
    }
    if (payload.item?.call_id && payload.item.name) {
      pushCall({ callId: payload.item.call_id, name: payload.item.name, arguments: payload.item.arguments ?? '{}' });
    }
    return calls;
  }

  private async attachScreenshotIfUseful(): Promise<void> {
    const transcript = this.finalTranscript || this.state.transcript;
    if (this.screenshotAttached || !shouldCaptureScreen(transcript)) return;
    this.screenshotAttached = true;
    try {
      const capture = await withTimeout(window.clicky.takeScreenshot(), 1200);
      this.patchState({ captures: [capture] });
      this.sendScreenshot(capture);
    } catch {
      void 0;
    }
  }

  private sendInitialUserMessage(): void {
    const content = this.buildInitialUserContent();
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content
      }
    });
  }

  private buildInitialUserContent(): Array<Record<string, string>> {
    const content: Array<Record<string, string>> = [
      {
        type: 'input_text',
        text: this.state.transcript
      }
    ];
    for (const capture of this.state.captures) {
      content.push({
        type: 'input_text',
        text: `Screen context from ${capture.label} (${capture.width}x${capture.height}).`
      });
      content.push({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${capture.jpegBase64}`
      });
    }
    return content;
  }

  private sendScreenshot(capture: ScreenCapturePayload): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Screen context from ${capture.label} (${capture.width}x${capture.height}).`
          },
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${capture.jpegBase64}`
          }
        ]
      }
    });
  }

  private createInitialResponseRequest(): unknown {
    if (!this.suppressAudioUntilToolResult) {
      return { type: 'response.create' };
    }

    return {
      type: 'response.create',
      response: {
        output_modalities: ['text'],
        tool_choice: 'required'
      }
    };
  }

  private waitForConnected(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for Realtime connection'));
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
          reject(new Error(`Realtime connection ${this.pc.connectionState}`));
        }
      };
      this.pc?.addEventListener('connectionstatechange', onStateChange);
      onStateChange();
    });
  }

  private waitForDataChannelOpen(): Promise<void> {
    if (this.dataChannel?.readyState === 'open') {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for Realtime data channel'));
      }, 8000);
      const cleanup = () => {
        clearTimeout(timeout);
        this.dataChannel?.removeEventListener('open', onOpen);
        this.dataChannel?.removeEventListener('error', onError);
        this.dataChannel?.removeEventListener('close', onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Realtime data channel failed before opening'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Realtime data channel closed before opening'));
      };
      this.dataChannel?.addEventListener('open', onOpen);
      this.dataChannel?.addEventListener('error', onError);
      this.dataChannel?.addEventListener('close', onClose);
    });
  }

  private patchState(patch: Partial<AgentState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }

  private fail(message: string): void {
    console.error('[clicky:realtime-agent] failed', JSON.stringify({
      agentId: this.options.agentId,
      message
    }));
    this.patchState({ status: 'error', error: message, completedAt: Date.now() });
    this.options.onError(message);
  }

  private send(payload: unknown): void {
    if (this.dataChannel?.readyState !== 'open') {
      throw new Error(`Realtime data channel is not open: ${this.dataChannel?.readyState ?? 'missing'}`);
    }
    this.dataChannel.send(JSON.stringify(payload));
  }

  private stopRemoteAudio(reason: string): void {
    this.reportLog('realtime_remote_audio_stopped', { reason });
    if (this.audio) {
      this.audio.pause();
      this.audio.muted = true;
      this.audio.srcObject = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.dataChannel?.close();
    this.pc?.close();
  }

  private speakRealtimePreambleIfSafe(toolName: string): void {
    if (!this.suppressAudioUntilToolResult || this.toolPreambleSpoken) return;
    const preamble = extractShortPreamble(this.responseText);
    if (!preamble) return;
    const blockReason = blockedPreambleReason(preamble, this.finalTranscript || this.state.transcript, toolName);
    if (blockReason) {
      this.toolPreambleSpoken = true;
      this.reportLog('realtime_preamble_blocked', {
        reason: blockReason,
        toolName,
        text: this.clip(preamble, 500)
      });
      this.patchState(this.progressPatchForTool(toolName));
      return;
    }
    this.toolPreambleSpoken = true;
    this.reportLog('realtime_preamble_accepted', { toolName, text: preamble });
    this.patchState({
      displayHeader: this.clip(preamble, 48),
      displayCaption: this.clip(preamble, 160),
      summary: this.clip(preamble, 200),
      response: ''
    });
    this.reportLog('realtime_preamble_tts_skipped', {
      reason: 'avoid_local_tts_overlap_with_realtime_audio',
      toolName
    });
  }

  private reportLog(type: string, details?: unknown): void {
    window.clicky.reportAgentLogEvent(this.options.agentId, type, details);
  }

  private bufferResponseDeltaLog(source: string, delta: string): void {
    this.responseDeltaLogBuffer += delta;
    if (this.responseDeltaLogBuffer.length >= 300) {
      this.flushResponseDeltaLog(source);
      return;
    }
    if (!this.responseDeltaLogTimer) {
      this.responseDeltaLogTimer = setTimeout(() => this.flushResponseDeltaLog(source), 500);
    }
  }

  private flushResponseDeltaLog(source = 'response.delta'): void {
    if (this.responseDeltaLogTimer) {
      clearTimeout(this.responseDeltaLogTimer);
      this.responseDeltaLogTimer = undefined;
    }
    const text = this.responseDeltaLogBuffer;
    if (!text) return;
    this.responseDeltaLogBuffer = '';
    this.reportLog('realtime_response_delta', {
      source,
      text: this.clip(text, 1200),
      accumulatedResponse: this.clip(this.responseText, 1200),
      suppressAudioUntilToolResult: this.suppressAudioUntilToolResult
    });
  }

  private progressPatchForTranscript(transcript: string): Partial<AgentState> {
    if (shouldForceEmailToolCall(transcript)) {
      return this.progressPatch('Checking email', 'Checking your email...');
    }
    if (shouldForceFileCleanupToolCall(transcript)) {
      return this.progressPatch('Cleaning desktop', 'Moving Excel, Word, and PDF files to trash...');
    }
    return this.progressPatch('Working', 'Running the requested action...');
  }

  private progressPatchForTool(toolName: string): Partial<AgentState> {
    if (toolName === 'check_email') {
      return this.progressPatch('Checking email', 'Checking your email...');
    }
    if (toolName === 'execute_bash_command' || toolName === 'desktop_cleanup') {
      return this.progressPatchForTranscript(this.finalTranscript || this.state.transcript);
    }
    if (toolName === 'scrape_website') {
      return this.progressPatch('Reading website', 'Fetching the page...');
    }
    if (toolName === 'open_url') {
      return this.progressPatch('Opening link', 'Opening the link...');
    }
    if (toolName === 'write_file') {
      return this.progressPatch('Writing file', 'Writing the file...');
    }
    return this.progressPatch('Working', 'Running the requested action...');
  }

  private progressPatch(displayHeader: string, displayCaption: string): Partial<AgentState> {
    return {
      displayHeader,
      displayCaption,
      summary: displayCaption,
      response: ''
    };
  }

  private clip(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  }

  private async getSilentAudioStream(): Promise<MediaStream> {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    return destination.stream;
  }
}

export function shouldCaptureScreen(transcript: string): boolean {
  return /\b(this|that|screen|page|window|image|picture|what (?:is|are)|what's|look|see|visible|shown|displayed|about)\b/i.test(transcript);
}

function shouldForceEmailToolCall(transcript: string): boolean {
  return /\b(email|emails|mail|inbox|message|messages|gmail)\b/i.test(transcript);
}

function shouldRequireToolBeforeSpeaking(transcript: string): boolean {
  return shouldForceEmailToolCall(transcript)
    || shouldForceFileCleanupToolCall(transcript)
    || /\b(file|files|folder|folders|directory|directories|desktop|home screen|docx|xlsx|document|spreadsheet|clean|cleanup|declutter|tidy|remove|delete|move|organize|organise|trash)\b/i.test(transcript);
}

function shouldForceFileCleanupToolCall(transcript: string): boolean {
  return /\b(desktop|home screen|docx|xlsx|pdf|document|spreadsheet|excel|clean|cleanup|declutter|tidy|remove|delete|move|trash)\b/i.test(transcript)
    && /\b(file|files|docx|xlsx|pdf|document|spreadsheet|excel|desktop|home screen)\b/i.test(transcript);
}

function isResponseTextDelta(type: string | undefined): boolean {
  return type === 'response.audio_transcript.delta'
    || type === 'response.output_audio_transcript.delta'
    || type === 'response.text.delta'
    || type === 'response.output_text.delta';
}

function extractShortPreamble(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const firstSentence = clean.match(/^(.{1,220}?[.!?])(?:\s|$)/)?.[1]?.trim();
  return firstSentence ?? (clean.length <= 180 ? clean : '');
}

function blockedPreambleReason(preamble: string, transcript: string, toolName: string): string | undefined {
  const text = preamble.toLowerCase().replace(/[’‘]/g, "'");
  const userText = transcript.toLowerCase();
  const tool = toolName.toLowerCase();

  if (/\b(i\s+(?:cannot|can't|can not|do not|don't|won't|am unable)|i'm unable|i am unable|i can only|you(?:'d| would)? need to|you can)\b/.test(text)) {
    return 'refusal_or_manual_instruction';
  }
  if (/\b(no access|without access|cannot access|can't access|not able to access|not directly access|not directly control|not directly move)\b/.test(text)) {
    return 'false_capability_claim';
  }

  if (tool === 'check_email' && !/\b(email|mail|inbox|message|messages)\b/.test(text)) {
    return 'missing_email_action';
  }
  if ((tool === 'execute_bash_command' || shouldForceFileCleanupToolCall(userText)) && shouldForceFileCleanupToolCall(userText)) {
    if (/\b(try|you can|make|create|add|keep|sort|folder|folders|subfolder|subfolders|to review)\b/.test(text)) {
      return 'manual_cleanup_suggestion';
    }
    if (!/\b(move|moving|clean|cleaning|declutter|organize|organise|trash|desktop|files?)\b/.test(text)) {
      return 'missing_file_cleanup_action';
    }
    if (!/\b(i'll|i will|i'm|i am|moving|cleaning|decluttering|organizing|organising)\b/.test(text)) {
      return 'not_action_preamble';
    }
  }
  if (tool === 'write_file' && !/\b(write|writing|create|creating|build|building|save|saving|file|app|website|page)\b/.test(text)) {
    return 'missing_write_action';
  }
  if (tool === 'open_url' && !/\b(open|opening|launch|visit|link|url|website|site)\b/.test(text)) {
    return 'missing_open_action';
  }
  if (tool === 'scrape_website' && !/\b(read|reading|fetch|fetching|summar|page|website|site)\b/.test(text)) {
    return 'missing_scrape_action';
  }

  return undefined;
}

function buildFileCleanupFinalResponse(output: string): string {
  const target = output.match(/Target:\s*(.*?)\s+Matching files before:/s)?.[1]?.trim() ?? 'your Desktop';
  const before = Number(output.match(/Matching files before:\s*(\d+)/)?.[1] ?? NaN);
  const remaining = Number(output.match(/Matching files remaining:\s*(\d+)/)?.[1] ?? NaN);
  const moved = Number(output.match(/Moved to trash:\s*(-?\d+)/)?.[1] ?? NaN);
  const hasError = /\bERROR:|failed|syntax error|Command failed/i.test(output);

  if (hasError) {
    return 'The cleanup command ran, but it did not complete successfully. No cleanup result was confirmed.';
  }

  if (Number.isFinite(moved) && Number.isFinite(remaining)) {
    if (moved > 0) {
      return `All set. I moved ${moved} matching Excel, Word, and PDF files from ${target} to the trash. There are ${remaining} matching files remaining.`;
    }
    if (Number.isFinite(before) && before === 0) {
      return `I checked ${target}. There were no matching Excel, Word, or PDF files to move.`;
    }
    return `I checked ${target}. No files were moved, and there are ${remaining} matching files remaining.`;
  }

  return 'The cleanup command finished, but I could not parse the cleanup count from its output.';
}

function extractTranscriptFromDonePayload(payload: RealtimeEvent): string {
  const outputs = payload.response?.output ?? [];
  const transcripts = outputs
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((c) => c.transcript || c.text || '')
      .filter(Boolean);
  return transcripts.join(' ').trim();
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
