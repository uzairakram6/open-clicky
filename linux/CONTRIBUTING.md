# Contributing

Thanks for helping improve Linux Clicky.

## Development Workflow

1. Install dependencies with `npm install`.
2. Create a local `.env` from `.env.example`.
3. Make focused changes with tests where practical.
4. Run the relevant checks before opening a pull request:

```sh
npm test
npx tsc -p tsconfig.json --noEmit
```

For packaging or desktop behavior changes, also run:

```sh
npm run build
npm run smoke:packaged
```

## Pull Requests

- Keep generated artifacts out of commits.
- Do not commit secrets, real email credentials, screenshots containing private data, or local test output.
- Document user-visible behavior changes.
- Call out any security-sensitive changes involving shell execution, file access, email access, screen capture, or network requests.

## Code Style

Use the existing TypeScript and React patterns in the repository. Prefer small, explicit changes over broad refactors.
