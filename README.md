# Linux Clicky

Linux Clicky is an Electron desktop client for a voice-first AI assistant on Linux. It opens a small cursor-anchored recorder, captures optional screen context, streams agent progress in compact widgets, and can use local tools for files, websites, email, and generated mini apps.

A longer overview (features, architecture, packaging) lives in [docs/meta/README.detailed.md](docs/meta/README.detailed.md).

## Status

This repository is early software. It is intended for developers and testers who are comfortable reviewing local-agent behavior before using it on important data.

## Features

- Electron, React, Vite, and TypeScript desktop app.
- Global shortcut and tray entry for quick voice capture.
- OpenAI speech, transcription, chat, and realtime agent flows.
- Optional screen capture context.
- Local tool loop for reading files, writing generated app files under `/tmp/clicky_apps`, opening URLs/files, scraping websites, and checking configured IMAP inboxes.
- Unit, contract, Playwright E2E, and packaged-renderer smoke test entry points.

## Requirements

- Linux desktop session.
- Node.js 22 or newer.
- npm.
- GCC and X11 development headers for building `src/main/cursor_query.c`.
- Electron runtime dependencies for your distribution.
- Optional desktop tools used by capture/hotkey fallbacks: `gsettings`, `grim`, `gnome-screenshot`, `ffmpeg`, `xdg-open`.

On Debian/Ubuntu, the native build dependency is typically:

```sh
sudo apt install build-essential libx11-dev
```

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env` and set:

```sh
OPENAI_API_KEY=your_api_key_here
```

## Development

```sh
npm run dev
```

In another terminal, run the Electron main process from the built output when needed:

```sh
npm run build:app
electron dist/main/main.js
```

## Build

```sh
npm run build
```

This creates Linux AppImage and deb packages in `dist/`.

## Tests

```sh
npm test
npx tsc -p tsconfig.json --noEmit
npm run test:contract
```

Real OpenAI contract and smoke flows require `OPENAI_API_KEY`. Some tests intentionally skip live API checks when the key is absent.

## Security And Privacy

Linux Clicky is a local desktop agent with powerful tools. Depending on the prompt and enabled settings, it can read local files, write files under `/tmp/clicky_apps`, open URLs/files, inspect recent email through IMAP, and execute shell commands. Review prompts, logs, and tool behavior before using it with sensitive data.

Settings are stored in Electron user data. Email passwords are not written back to settings by the current serializer; prefer app-specific passwords or dedicated test accounts for IMAP use.

Agent run logs are stored in Electron user data for debugging. They may contain transcripts, filenames, email metadata, or tool outputs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
