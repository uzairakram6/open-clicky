# Open Clicky V1 Manual Acceptance

Run this matrix on real desktop sessions before tagging V1. The Electron build and unit tests can verify packaging and contracts, but tray behavior, global shortcuts, PipeWire capture, mic permissions, and playback need real Linux desktops.

## Test Matrix

| Environment | Tray appears | Shortcut toggles recording | Mic prompt works | Screen picker/capture works | Claude response streams | TTS plays | Quit cleans up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ubuntu GNOME Wayland | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| Ubuntu GNOME X11 | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| KDE Plasma Wayland | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

## Setup

1. Build packages from the repository root:

   ```sh
   npm run build
   ```

2. Install the deb or run the AppImage:

   ```sh
   sudo apt install ./dist/open-clicky_0.1.0_amd64.deb
   ./dist/open-clicky-0.1.0.AppImage
   ```

3. Open Clicky from the tray menu and set the Worker base URL.

4. Optional packaged-renderer smoke check on a desktop session with `agent-browser` installed:

   ```sh
   npm run smoke:packaged
   ```

## Acceptance Steps

1. Confirm the tray icon is visible. Use the context menu and verify `Show`, `Start/Stop Recording`, `Settings`, and `Quit` are present.
2. Press `Ctrl+Alt+Space`. The panel should enter `listening`; press it again and the panel should stop recording.
3. Accept the microphone prompt. Confirm the audio level meter moves while speaking.
4. Select a screen with `Screens`, then stop a recording turn. Confirm the system picker appears where the desktop requires it and the selected screen is captured.
5. Speak or type a test transcript, then stop recording. Confirm the response streams into the panel.
6. Confirm `[POINT:...]` tags, if returned by the Worker, are not visible in the panel and are not spoken.
7. Confirm TTS plays after the full response. If TTS fails, confirm the text response remains visible and an error is shown.
8. Quit from the tray menu. Relaunch and confirm the global shortcut is not left registered by the previous process.
