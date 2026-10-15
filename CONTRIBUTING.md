# Contributing

Thanks for wanting to help defuse bombs! A few ground rules:

## Getting started

1. Fork the repo and clone it.
2. `npm install`, then `npm test` — the suite in `shared/` must pass.
3. For local play: `npx wrangler dev` and open the printed URL in 2–3 tabs.

## Where the code lives

- `shared/game.js` — pure game rules (bomb generation, clue dealing, action
  validation). **No platform APIs here** — it must keep working in plain Node.
- `worker/` — Cloudflare Worker + the `GameRoom` Durable Object (WebSockets,
  timer alarms, bots).
- `client/` — vanilla HTML/CSS/JS. No build step, no framework.

## Pull requests

- Keep changes small and focused; one idea per PR.
- Add or update unit tests in `shared/` when you touch game rules.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Explain *why* in the PR description, not just *what*.

## Good first issues

Look for issues labeled `good first issue` — they're scoped to be doable in
an evening (new modules, sounds, layout polish).

## Code of conduct

Be kind. We're all here to have fun and learn. Harassment or hate speech gets
you removed — no second chances.
