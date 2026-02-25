# AGENTS.md

## Cursor Cloud specific instructions

### Overview

TanStack AI is a pnpm monorepo (pnpm@10.17.0) using Nx for task orchestration, Vite for builds, Vitest for tests, and TypeScript 5.9.3. No databases or external services are required for library development — unit tests use mocks.

### Node.js

Requires Node.js 24.8.0 (see `.nvmrc`). Use `nvm use` to activate the correct version.

### Common commands

See `CLAUDE.md` for the full command reference. Key commands:

- `pnpm build:all` — build all library packages
- `pnpm test:ci` — full CI suite (lint, types, tests, build) via `nx run-many`
- `pnpm test:lib` / `pnpm test:eslint` / `pnpm test:types` — individual checks (use `nx run-many --target=<target> --exclude='examples/**'` to test all packages, since the `affected` variants require changes vs `main`)
- `pnpm dev` / `pnpm watch` — watch mode for library development
- `pnpm format` — Prettier formatting

### Running examples

Examples live in `examples/` and are excluded from the Nx build graph. Run them directly:

```bash
cd examples/ts-react-chat && pnpm dev  # port 3000
```

Most examples require AI provider API keys (e.g. `OPENAI_API_KEY`). See each example's `.env.example` for required variables.

### Gotchas

- The `pnpm test:lib`, `pnpm test:eslint`, and `pnpm test:types` scripts use `nx affected` which compares against `main`. On branches with no diff, they report "No tasks were run". Use `pnpm test:ci` or `nx run-many --target=<target>` to run against all packages.
- pnpm warns about ignored build scripts (`esbuild`, `nx`, etc.). These use Nx remote cache and work correctly without running postinstall scripts.
- Svelte tsconfig warning (`Cannot find module './.svelte-kit/tsconfig.json'`) is benign and appears during builds/tests — this is expected since the SvelteKit generated config doesn't exist in a fresh checkout.
