# Security Policy

## Supported Versions

Open Clicky is pre-1.0. Security fixes are handled on the default branch.

## Reporting A Vulnerability

Please report security issues privately to the maintainers before opening a public issue. If no private contact is configured for your fork, create a minimal public issue that does not include exploit details and ask for a private disclosure channel.

## Security Model

Open Clicky is a local desktop assistant. It can call OpenAI APIs and can expose local capabilities to an agent tool loop, including shell execution, file reads, generated file writes, URL/file opening, screen capture, website scraping, and IMAP email access.

Treat the app as trusted local software with agentic permissions. Review code and configuration before running it on sensitive machines.

## Secrets

Do not commit `.env`, API keys, email passwords, private logs, screenshots, packaged builds, or test artifacts. Use `.env.example` for documenting configuration shape.
