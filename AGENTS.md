# Repository Guidelines

## Project Structure & Module Organization

```
WebAI2API/
├── src/
│   ├── server/          # HTTP API server (Express-style routing, queue, auth)
│   │   └── api/         # OpenAI-compatible & Codex endpoints
│   ├── backend/         # Browser automation layer (Playwright + Camoufox)
│   │   ├── adapters/    # Per-website interaction adapters
│   │   └── strategies/  # Load-balancing & failover strategies
│   ├── config/          # YAML config loading, validation, runtime manager
│   └── utils/           # Logging, IPC, proxy helpers, stats
├── scripts/             # postinstall, key generation, initialization scripts
├── patches/             # Patched Camoufox modules (locale, pkgman, utils)
├── supervisor.js        # Entry point — process manager with Xvfb & auto-restart
├── config.example.yaml  # Reference configuration template
└── docker-compose.yaml  # Container deployment
```

**Key conventions:**
- Entry point is `supervisor.js` (not `index.js`). It spawns the server and manages lifecycle.
- Subpath imports (`#config`, `#utils/*`, `#backend/*`, `#server/*`) are used for internal modules.
- Each website integration lives as a dedicated adapter under `src/backend/adapters/`.

## Build, Test, and Development Commands

| Command | Description |
|---|---|
| `pnpm start` | Start the production supervisor (manages Xvfb + server) |
| `pnpm start -- -login` | Launch in login mode to authenticate browser instances |
| `pnpm run genkey` | Generate a secure API key for auth |
| `pnpm run init` | Initialize configuration and data directories |
| `pnpm install` | Install dependencies (triggers postinstall patching) |

There is no dedicated test suite in this repository.

## Coding Style & Naming Conventions

- **Runtime:** Node.js with ES modules (`"type": "module"`).
- **Indentation:** Tabs (as seen in `config.example.yaml` and source files).
- **Naming:** kebab-case for files (`cloudflare-bypass.js`), camelCase for variables/functions.
- **JSDoc:** Top-level functions and modules use `@fileoverview` and `@description` blocks.
- **Config:** YAML-based (`config.yaml`), validated at startup by `src/config/validator.js`.
- **Linting:** No formal linter is configured — follow existing patterns in adjacent files.

## Commit & Pull Request Guidelines

- **Commit format:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, `docs:`, prefixed messages.
- **Issue references:** Use `(closes #XX)`, `(ref #XX)` to link issues.
- **PR scope:** Keep pull requests focused on a single feature or fix.
- **Description:** Include the motivation, affected adapters, and any config changes required.

## Configuration & Security Tips

- Copy `config.example.yaml` to `config.yaml` and customize before running.
- Use `pnpm run genkey` to generate a strong `server.auth` token (minimum 10 characters).
- Browser instances can be isolated with per-instance `userDataMark` and per-instance proxy settings.
- Adapter-specific settings (e.g., `gemini_biz.entryUrl`) go under `backend.adapter.<adapterId>`.
