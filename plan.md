# Linux Clicky V1 Plan

## Summary

Build a new Electron Linux app under linux/ that reuses the existing Cloudflare Worker API contract but replaces all macOS-only client code. V1 targets Wayland + X11, uses a tray panel, toggle-to-record
global shortcut, selected-screen capture, Claude streaming response, AssemblyAI transcription, and ElevenLabs playback. The blue cursor overlay and [POINT:...] animation are out of v1.

References used: Electron globalShortcut with Wayland GlobalShortcutsPortal, Electron desktopCapturer Linux/PipeWire caveat, and Electron Tray Linux behavior.

## Key Changes

- Add an Electron + TypeScript + React/Vite app in linux/.
- Package with electron-builder for AppImage and deb.
- Keep API keys server-side by routing all Claude, AssemblyAI token, and ElevenLabs calls through the existing Worker.
- Store only non-secret settings locally: worker base URL, selected Claude model, shortcut preference, selected capture source/session metadata, onboarding/preferences.
- Use Electron main process for trusted services:
    - tray lifecycle and panel window
    - globalShortcut registration with GlobalShortcutsPortal enabled
    - Worker /chat, /tts, /transcribe-token calls
    - SSE parsing and IPC stream events
- Use renderer/preload for UI and browser media APIs:
    - mic capture through navigator.mediaDevices.getUserMedia
    - PCM16 conversion for AssemblyAI streaming
    - selected-screen capture through getDisplayMedia/Electron display media handler
    - response rendering and TTS playback from audio bytes returned by main

## Interfaces

- Add typed IPC exposed through contextBridge, with no Node integration in renderer:
    - capture:selectScreen, capture:captureSelectedScreen
    - chat:sendTurn, streaming back chat:chunk, chat:done, chat:error
    - tts:speak, tts:stopped, tts:error
- Define shared TypeScript types:
    - AppSettings
    - VoiceState = idle | listening | processing | responding
    - ScreenCapturePayload { jpegBase64, label, width, height }
    - VoiceTurnRequest { transcript, captures, model, conversationHistory }
    - ChatStreamEvent { type, text?, error? }
- Keep Worker routes unchanged unless Electron main-process fetch exposes an actual missing header/runtime issue.

## Behavior

- Tray icon opens a compact Clicky panel. Because Linux tray activation differs by desktop, also provide a context menu with Show, Start/Stop Recording, Settings, Quit.
- Toggle shortcut starts recording; pressing it again stops recording and sends the turn. Default shortcut: Ctrl+Alt+Space.
- First screen capture uses the system picker where required. V1 captures the selected screen, scales the JPEG to max dimension 1280, and labels it as the selected Linux screen.
- The panel shows recording state, audio level, live transcript, streamed Claude response, model selector, capture-source status, and error states.
- TTS plays after the full response is available. If TTS fails, text response remains visible.
- Strip or ignore [POINT:...] tags in v1 so Claude responses do not expose internal cursor commands to the user.

## Test Plan

- Unit tests:
    - SSE parser handles text deltas, done events, malformed lines, and HTTP errors.
    - PCM float-to-PCM16 conversion clamps and encodes correctly.
    - Worker request payload matches current /chat, /tts, and /transcribe-token expectations.
    - [POINT:...] tags are removed from displayed/spoken text.
- Integration tests:
    - IPC contract tests with mocked Worker responses.
    - Fake AssemblyAI websocket session for transcript updates/finalization.
    - Fake TTS response verifies audio bytes reach renderer playback path.
- Manual acceptance matrix:
    - Ubuntu GNOME Wayland
    - Ubuntu GNOME X11
    - KDE Plasma Wayland
    - Verify tray appears, shortcut toggles recording, mic prompt works, screen picker/capture works, Claude response streams, TTS plays, and quitting cleans up shortcuts/windows.

## Assumptions

- Electron is the chosen Linux stack.
- V1 supports Wayland + X11.
- V1 uses toggle-to-record, not hold-to-talk.
- V1 captures one selected screen, not all monitors.
- V1 packages AppImage and deb.
- Cursor overlay/element pointing is deferred until after the core voice MVP proves reliable on target Linux desktops.
