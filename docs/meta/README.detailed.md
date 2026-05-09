# 🎙️ Clicky — Linux Voice Assistant

**Clicky** is a privacy-aware, voice-driven AI assistant for Linux desktops. It lives in your system tray, listens on a global hotkey, and gives you an AI agent that can see your screen, run commands, write files, check email, browse the web, and answer questions — all by speaking.

Built with Electron, React, TypeScript, and Vite. Supports **Wayland** and **X11**.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Push-to-Talk** | Press `Ctrl+Alt+Space` to start recording — press again to send |
| **Voice Transcription** | Real-time transcription via OpenAI Realtime API or Whisper fallback |
| **Screen Context** | Captures a screenshot of your selected monitor so the AI can see what you see |
| **Streaming AI Responses** | Claude/OpenAI responses stream token-by-token into a floating agent window |
| **Text-to-Speech** | Response is spoken aloud via OpenAI TTS (with espeak/spd-say fallback) |
| **System Tray** | Tray icon with context menu — always accessible |
| **Wayland + X11** | Detects session type and configures Electron accordingly; GNOME custom shortcut registration |
| **Tool-Using Agent** | The AI can execute bash commands, write files, check IMAP email, scrape websites, open URLs, and download attachments |
| **Packaged** | Ships as AppImage and `.deb` — ready for Ubuntu/Debian and derivatives |

---

## 🖼️ How It Works

```
┌─────────────────────────────────────────────────┐
│                  System Tray                     │
│     ┌───────────┐    ┌──────────────────┐       │
│     │  Recorder  │    │  Agent Window    │       │
│     │  (Orb)     │    │  (Floating UI)   │       │
│     └─────┬─────┘    └────────┬─────────┘       │
│           │                   │                  │
│      ┌────▼────────────────────▼─────────┐       │
│      │       Electron Main Process       │       │
│      │  ┌─────────────────────────────┐  │       │
│      │  │  WorkerApi (HTTP + SSE)      │  │       │
│      │  │  Settings (JSON file)        │  │       │
│      │  │  GlobalShortcut              │  │       │
│      │  │  Shell Exec / File Write     │  │       │
│      │  │  Email (IMAP) / Web Scraper  │  │       │
│      │  └─────────────────────────────┘  │       │
│      └────────────────┬──────────────────┘       │
│                       │                          │
│              ┌────────▼────────┐                  │
│              │  OpenAI API     │                  │
│              │  (Chat, TTS,    │                  │
│              │   Transcription)│                  │
│              └─────────────────┘                  │
└─────────────────────────────────────────────────┘
```

### Flow

1. **Press** `Ctrl+Alt+Space` — a small translucent orb appears at your cursor
2. **Speak** — the orb shows a live audio level meter; your voice is streamed to OpenAI Realtime API for transcription (or recorded and transcribed via Whisper when done)
3. **Press again** (or pause for silence) — transcription completes, a screenshot is captured, and both are sent to the AI
4. **AI responds** — a floating agent window materializes near the top-right of your screen, streaming the response in real-time
5. **TTS plays** — the full response is spoken aloud. If OpenAI TTS fails, the system falls back to `spd-say` or `espeak-ng` (or browser `SpeechSynthesis`)
6. **Follow up** — type or speak follow-up questions to continue the conversation

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- Linux with **X11** or **Wayland** (GNOME, KDE Plasma, etc.)
- An **OpenAI API key** with access to:
  - `gpt-4o` / `gpt-4o-mini` (chat completions)
  - `tts-1` (text-to-speech)
  - `whisper-1` / `gpt-4o-mini-transcribe` (audio transcription)
  - `gpt-4o-realtime-preview` (optional, for realtime streaming transcription)

### Install & Run

```bash
# Clone the repo
git clone <repo-url> linux-clicky
cd linux-clicky

# Install dependencies
npm install

# Create .env with your OpenAI key
echo "OPENAI_API_KEY=sk-..." > .env

# Run in development mode
npm run dev
```

### Build & Package

```bash
npm run build
```

This produces:
- `dist/Clicky-<version>.AppImage`
- `dist/linux-clicky_<version>_amd64.deb`

### Install the Package

```bash
sudo apt install ./dist/linux-clicky_0.1.0_amd64.deb
# or
./dist/Clicky-0.1.0.AppImage
```

---

## ⌨️ Usage

### Global Shortcut

- **Default**: `Ctrl+Alt+Space`
- Configure via `CLICKY_HOTKEY` env var (e.g. `CLICKY_HOTKEY=Alt+Shift+C`)
- On GNOME Wayland, a custom gsettings keybinding is automatically registered as a fallback (configurable with `CLICKY_GNOME_HOTKEY`)

### System Tray

Right-click the Clicky tray icon for:
- **Settings** — configure Worker URL, model, screen source
- **Open Clicky Recorder** — manually open the recording orb
- **Quit** — exit the application

### Agent Window

When the AI responds, a floating window appears. From it you can:
- View the streamed response
- See the "command" being executed (terminal-box flash)
- Click **suggested actions** (Copy Response, Open Folder, etc.)
- **Follow up** via text input or voice
- **Minimize** back to a compact dot
- **Close** the agent

---

## 🧩 Architecture

### Project Structure

```
.
├── src/
│   ├── main/                 # Electron main process
│   │   ├── main.ts           # App lifecycle, tray, shortcuts, windows, IPC handlers
│   │   ├── workerApi.ts      # OpenAI API client (chat completions, TTS, transcription tokens)
│   │   ├── sse.ts            # SSE parser for streaming responses
│   │   ├── settings.ts       # Local settings persistence
│   │   ├── scraper.ts        # Web scraping with Readability + linkedom
│   │   └── emailService.ts   # IMAP email fetching and attachment download
│   ├── preload/
│   │   └── preload.ts        # contextBridge: typed IPC for renderer (no Node access)
│   ├── renderer/             # React UI
│   │   ├── App.tsx           # Root — routes to Recorder or AgentWidget based on window context
│   │   ├── Recorder.tsx      # Push-to-talk orb UI
│   │   ├── AgentWidget.tsx   # Floating agent widget with streaming response
│   │   ├── useVoiceRecorder.ts # Microphone hook (getUserMedia, MediaRecorder, silence detection)
│   │   ├── transcriber.ts    # OpenAI Realtime WebRTC transcriber
│   │   ├── playAudio.ts      # Audio playback utility
│   │   └── styles.css        # Full UI styling
│   └── shared/               # Shared between main and renderer
│       ├── types.ts          # TypeScript type definitions
│       ├── ipcChannels.ts    # IPC channel name constants
│       ├── audio.ts          # PCM float→PCM16 conversion, resampling
│       ├── pointTags.ts      # [POINT:...] tag stripping
│       └── acknowledgement.ts # Spoken task acknowledgement builder
├── scripts/
│   ├── download-vosk-model.sh
│   └── smoke-packaged-renderer.sh
├── vite.config.ts            # Vite config for renderer
├── vite.main.config.ts       # Vite config for main process
├── vite.preload.config.ts    # Vite config for preload (CJS output)
├── vitest.config.ts          # Vitest config
├── tsconfig.json
├── tsconfig.node.json
└── package.json
```

### Security Model

- **No Node.js in the renderer** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- All privileged operations (shell, filesystem, network) happen in the **main process**
- The renderer communicates exclusively through **typed IPC channels** via `contextBridge`
- **API keys stay server-side** — only the Worker base URL is stored locally; all OpenAI calls are routed through the main process / Worker proxy
- Local settings never store secrets — only non-sensitive preferences

### IPC Channels

| Channel | Direction | Purpose |
|---|---|---|
| `settings:get/set` | Renderer → Main | Read/write settings |
| `capture:selectScreen` | Renderer → Main | List available screens |
| `capture:takeScreenshot` | Renderer → Main | Capture a screenshot |
| `chat:sendTurn` | Renderer → Main | Send a voice turn to the AI |
| `audio:transcribe` | Renderer → Main | Transcribe audio via Whisper |
| `transcribe:getToken` | Renderer → Main | Get Realtime transcription token |
| `tts:speak` | Renderer → Main | Synthesize speech |
| `recording:start/stop` | Main → Renderer | Control recording state |
| `chat:chunk/done/error` | Main → Renderer | Stream AI response |
| `tts:audio/error` | Main → Renderer | Deliver TTS audio |
| `agent:spawn/update/close` | Renderer ↔ Main | Agent window lifecycle |
| `agent:followUp` | Renderer → Main | Send follow-up to existing agent |
| `shell:execute` | Renderer → Main | Execute bash command |
| `scrape:website` | Renderer → Main | Scrape web content |
| `open-url` | Renderer → Main | Open URL in browser |

### Types (key entities)

```typescript
type VoiceState = 'idle' | 'listening' | 'processing' | 'responding';

interface AppSettings {
  workerBaseUrl: string;
  model: string;
  selectedCaptureSourceId?: string;
  onboarded: boolean;
  email?: EmailConfig;
}

interface VoiceTurnRequest {
  transcript: string;
  captures: ScreenCapturePayload[];
  model: string;
  conversationHistory: ConversationMessage[];
}

interface AgentState {
  id: string;
  status: 'running' | 'done' | 'error';
  transcript: string;
  response: string;
  commands: string[];
  actions: AgentAction[];
  conversationHistory: ConversationMessage[];
  captures: ScreenCapturePayload[];
  emails?: EmailSummary[];
}
```

---

## 🔧 AI Tools

The Clicky agent has access to six tools, declared as OpenAI function-calling tools:

| Tool | Description |
|---|---|
| `execute_bash_command` | Run bash/shell commands on the local machine |
| `write_file` | Write code/text to files under `/tmp/clicky_apps/` |
| `check_email` | Fetch recent emails from the configured IMAP inbox |
| `open_url` | Open a URL in the default web browser |
| `scrape_website` | Fetch and extract readable content from a URL |
| `download_email_attachment` | Download an attachment from a previously fetched email |

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Test file structure
src/
├── main/
│   ├── sse.test.ts
│   ├── workerApi.test.ts
│   └── scraper.test.ts
├── renderer/
│   ├── transcriber.test.ts
│   └── playAudio.test.ts
└── shared/
    ├── audio.test.ts
    ├── ipcChannels.test.ts
    ├── pointTags.test.ts
    └── acknowledgement.test.ts
```

Tests use **Vitest** with Node environment. They cover:
- SSE parsing (deltas, done events, malformed lines, HTTP errors)
- PCM float-to-PCM16 conversion
- Worker request payload format
- `[POINT:...]` tag stripping
- IPC channel contract consistency
- Audio playback fallback logic
- Web scraping extraction modes

---

## 🌐 Desktop Environments

| Environment | Support |
|---|---|
| Ubuntu GNOME (Wayland) | ✅ Full support — tray, shortcut, screen capture via `grim`, fallback to `desktopCapturer` |
| Ubuntu GNOME (X11) | ✅ Full support — tray, shortcut, screen capture via `ffmpeg x11grab` or `desktopCapturer` |
| KDE Plasma (Wayland) | ⚠️ Tray and shortcut work; screen capture via `desktopCapturer` (no `grim`/`ffmpeg` tested) |
| Other Wayland compositors | ⚠️ Should work with `desktopCapturer`; shortcut may need manual configuration |
| Other X11 desktops | ✅ Should work fully |

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** Your OpenAI API key |
| `CLICKY_HOTKEY` | `Control+Alt+Space` | Global shortcut for push-to-talk |
| `CLICKY_GNOME_HOTKEY` | `<Control><Alt>space` | GNOME Wayland shortcut binding format |
| `CLICKY_DEBUG_OPENAI_STREAM` | — | Set to `1` to enable verbose OpenAI stream logging |
| `VITE_DEV_SERVER_URL` | — | When set, loads renderer from this URL (Vite dev server) instead of built files |

### Settings (stored in `~/.config/clicky/settings.json`)

| Setting | Type | Description |
|---|---|---|
| `workerBaseUrl` | string | Base URL for the Worker API proxy |
| `model` | string | OpenAI model to use (e.g. `gpt-4o-mini`) |
| `selectedCaptureSourceId` | string | Saved screen capture source ID |
| `onboarded` | boolean | Whether onboarding is complete |
| `email` | object | IMAP email configuration (provider, username, password) |

---

## 📦 Dependencies

| Package | Purpose |
|---|---|
| `react` / `react-dom` | UI framework |
| `electron` | Desktop application shell |
| `vite` / `@vitejs/plugin-react` | Build tooling |
| `vitest` | Test runner |
| `typescript` | Type safety |
| `@mozilla/readability` | Web content extraction |
| `linkedom` | Lightweight DOM for server-side HTML parsing |
| `imap` / `mailparser` | IMAP email fetching |
| `electron-builder` | Package into AppImage and `.deb` |

---

## 📋 Roadmap (V1 Scope)

- [x] Electron + TypeScript + React/Vite app
- [x] AppImage and `.deb` packaging
- [x] Wayland + X11 support
- [x] System tray with context menu
- [x] Global push-to-talk shortcut with GNOME Wayland fallback
- [x] Selected-screen capture with system picker
- [x] Real-time and Whisper transcription
- [x] Streaming AI responses with SSE
- [x] Text-to-speech with fallback chain
- [x] Floating agent windows with follow-up support
- [x] Tool-using AI (bash, files, email, web, browser)
- [x] `[POINT:...]` tag stripping
- [ ] Cursor overlay / element pointing (deferred to V2)

---

## 📄 License

Clicky is provided under the MIT License. See `LICENSE` for details.
