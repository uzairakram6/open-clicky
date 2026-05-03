# Linux Clicky V1 Completion Audit

This audit maps `../plan.md` requirements to concrete artifacts and verification evidence.

## Deliverables

| Requirement | Evidence | Status |
| --- | --- | --- |
| Electron + TypeScript + React/Vite app under `linux/` | `package.json`, `vite.config.ts`, `vite.main.config.ts`, `vite.preload.config.ts`, `src/main`, `src/preload`, `src/renderer` | Implemented |
| Package AppImage and deb | `npm run build`, `dist/Clicky-0.1.0.AppImage`, `dist/linux-clicky_0.1.0_amd64.deb` | Implemented |
| Keep API keys server-side through Worker | `src/main/workerApi.ts`; local settings contain only Worker URL and preferences | Implemented |
| Store only non-secret settings | `src/main/settings.ts` sanitizes settings before write | Implemented |
| Main process owns tray, shortcut, Worker calls, SSE, IPC streaming | `src/main/main.ts`, `src/main/workerApi.ts`, `src/main/sse.ts` | Implemented |
| Renderer/preload owns UI, mic, PCM16, screen capture, response display, playback | `src/preload/preload.ts`, `src/renderer/App.tsx`, `src/renderer/transcriber.ts`, `src/shared/audio.ts` | Implemented |
| Typed IPC through contextBridge, no Node integration | `src/preload/preload.ts`, `src/shared/ipcChannels.ts`, `BrowserWindow.webPreferences` in `src/main/main.ts` | Implemented |
| Shared TypeScript types | `src/shared/types.ts` | Implemented |
| Tray panel and context menu with Show, Start/Stop Recording, Settings, Quit | `createTray()` in `src/main/main.ts` | Implemented; needs real-desktop validation |
| Toggle shortcut, default `Ctrl+Alt+Space` | `settings.ts`, `registerShortcut()` in `src/main/main.ts` | Implemented; needs real-desktop validation |
| Wayland GlobalShortcutsPortal | `app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')` in `src/main/main.ts` | Implemented; needs real-desktop validation |
| Selected screen capture with system picker where required | `session.defaultSession.setDisplayMediaRequestHandler()`, `captureSelectedScreen()` | Implemented; needs real-desktop validation |
| JPEG max dimension 1280 and selected Linux screen label | `captureSelectedScreen()` in `src/preload/preload.ts` | Implemented |
| Panel state, audio level, transcript, streamed response, model selector, capture status, errors | `src/renderer/App.tsx`, `src/renderer/styles.css` | Implemented |
| TTS after full response; text remains visible on TTS failure | `onChatDone`, `playAudio`, `onTtsError` in `src/renderer/App.tsx` | Implemented; needs live Worker/TTS validation |
| Strip/ignore `[POINT:...]` tags | `src/shared/pointTags.ts`, use in `workerApi.ts` and `App.tsx` | Implemented |
| Cursor overlay and pointing out of V1 | No overlay/pointing implementation included | Implemented |

## Test Plan Coverage

| Plan test | Evidence | Status |
| --- | --- | --- |
| SSE parser handles deltas, done, malformed lines, HTTP errors | `src/main/sse.test.ts` | Covered |
| PCM float-to-PCM16 clamps and encodes | `src/shared/audio.test.ts` | Covered |
| Worker `/chat`, `/tts`, `/transcribe-token` request paths | `src/main/workerApi.test.ts` | Covered |
| `[POINT:...]` tags removed from displayed/spoken text | `src/shared/pointTags.test.ts`, `workerApi.test.ts` | Covered |
| IPC contract tests with mocked responses | `src/shared/ipcChannels.test.ts` | Partially covered at channel-contract level |
| Fake AssemblyAI websocket transcript updates/finalization | `src/renderer/transcriber.test.ts` | Covered at message parser level |
| Fake TTS verifies audio bytes reach renderer playback path | Worker bytes covered in `workerApi.test.ts`; renderer playback covered in `src/renderer/playAudio.test.ts` | Covered |
| Manual Ubuntu GNOME Wayland | `npm run smoke:packaged` validates packaged renderer on current GNOME Wayland session | Partially covered |
| Manual Ubuntu GNOME X11 | No X11 desktop session available in this environment | Blocked |
| Manual KDE Plasma Wayland | No KDE Wayland desktop session available in this environment | Blocked |

## Verified Commands

Last local verification run:

```sh
npm test
npm run build
npm run smoke:packaged
dpkg-deb --info dist/linux-clicky_0.1.0_amd64.deb
```

Observed status:

- `npm test`: 7 files, 11 tests passed.
- `npm run build`: completed successfully.
- `npm run smoke:packaged`: passed.
- `dpkg-deb --info`: package metadata readable and valid.

## Remaining Blocker

The plan is not fully complete until the manual acceptance matrix in `MANUAL_ACCEPTANCE.md` is run on:

- Ubuntu GNOME Wayland
- Ubuntu GNOME X11
- KDE Plasma Wayland

The current environment only exposed an Ubuntu GNOME Wayland session and no live Worker/TTS setup, so the full manual matrix cannot be completed here.
