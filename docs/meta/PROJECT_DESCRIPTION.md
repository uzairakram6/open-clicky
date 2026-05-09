# Open Clicky — Project Description

## Business Layer

Open Clicky is a Linux-native voice AI assistant that lives in your system tray and collapses the friction of desktop computing into a single voice interface. Instead of switching between terminal, browser, email client, and file manager, you press a hotkey, speak what you want, and the assistant does it — runs commands, writes files, checks IMAP email, scrapes web pages, opens URLs, downloads attachments, and answers questions.

It differentiates from other voice assistants in three ways: it is **Linux-first** (Wayland + X11), it is **privacy-conscious** (API keys stay server-side, only preferences stored locally), and it is **deeply agentic** — it executes actions on your machine, not just conversation.

The core value proposition: the shortest path from intent to outcome is a spoken sentence.

## Technical Architecture

Open Clicky is an Electron app in TypeScript with a React renderer, built with Vite and packaged as AppImage/.deb. It follows a strict three-layer isolation model:

- **Main process** — owns all privileged operations: system tray, global shortcuts, window management, OpenAI API calls (chat completions, TTS, transcription tokens), shell execution, IMAP email, web scraping, SSE streaming, and all IPC handlers. Detects Wayland vs X11 at startup and configures Electron accordingly (Ozone platform hints, GlobalShortcutsPortal disable, GNOME gsettings fallback).
- **Preload** — exposes a typed `window.clicky` API via contextBridge with ~25 methods/event listeners. Zero Node.js access in the renderer.
- **Renderer** — sandboxed React app that routes between two window types based on window context: **Recorder** (tiny 80×40 cursor-following orb) and **AgentWidget** (floating 52×52→340×420 expandable conversation panel with arrival animations, streaming response, command flash terminal, follow-up via text or voice).

Agent windows are separate BrowserWindows — frameless, transparent, always-on-top, skip-taskbar. Each represents one conversation session with its own state, color, and lifecycle. Multiple agents can run concurrently.

## End-to-End Voice Flow

1. **Trigger** — User presses `Ctrl+Alt+Space`. Main process creates an 80×40 frameless window at the cursor position, starts a 16ms cursor-tracking interval, sends `recording:start` IPC after 300ms.

2. **Capture** — Recorder receives the event, calls `getUserMedia({ audio: true })`, creates a MediaRecorder and an AudioContext with AnalyserNode for level metering.

3. **Transcription** — Audio flows over WebRTC to OpenAI Realtime API. Transcription deltas arrive on a data channel as `conversation.item.input_audio_transcription.delta` events. When silence is detected server-side, a `completed` event fires with the final transcript. Simultaneously, a client-side silence detector (2s threshold at 0.018 amplitude) runs in a rAF loop as a backup trigger.

4. **Stop** — Either the silence timeout fires or the user presses the hotkey again. MediaRecorder stops, WebRTC connection closes, final transcript is collected. If realtime transcription was unavailable, the recorded audio blob is sent to OpenAI Whisper as fallback.

5. **Screen capture (conditional)** — If the transcript contains keywords like "this", "screen", "what is", "look", a screenshot is taken via a tiered fallback: Wayland tries `grim` first then `desktopCapturer`; X11 tries `ffmpeg x11grab` then `desktopCapturer`. JPEG at 82% quality, max dimension 1280, base64-encoded.

6. **Agent spawn** — Recorder calls `spawnAgent(transcript, captures, model)`. Main process creates a UUID, builds a new BrowserWindow, initializes AgentState (status=running), stores it in an in-memory map, waits for the window to load, sends the initial state to the renderer, and optionally speaks a task acknowledgement via OpenAI TTS (falling back to spd-say → espeak-ng → browser SpeechSynthesis).

7. **AI chat** — Main process calls OpenAI `/v1/chat/completions` with `stream: true`, a system prompt defining Open Clicky's personality and six tools, the transcript + screen captures as user content, and tool definitions. The SSE response is parsed token-by-token, yielding `chunk`, `tool_call`, `done`, or `error` events. Text chunks are flushed to the renderer via IPC with batching (50ms interval or 160-char threshold).

8. **Tool execution** — When a `tool_call` is received, the main process executes it: `execute_bash_command` (child_process.exec), `write_file` (under /tmp/clicky_apps/ with path validation), `check_email` (IMAP with Gmail/Outlook/Yahoo defaults), `open_url` (shell.openExternal), `scrape_website` (Readability + linkedom), or `download_email_attachment` (IMAP + file write). The result is fed back into a recursive stream call so the AI can see the output and continue reasoning.

9. **Completion** — On `done`, the main process finalizes AgentState with the full response, a 200-char summary, inferred suggested actions, and conversation history. Sends `chat:done` and `agent:update` IPC to the renderer. Kicks off background TTS: OpenAI TTS → spd-say → espeak-ng → browser SpeechSynthesis. If all TTS fails, the text remains visible with an error badge.

10. **Follow-up** — The user can type or speak follow-up questions from the agent window footer, which calls `followUp(agentId, newRequest)`, resetting the agent state to running and repeating steps 7-9 with the accumulated conversation history.
