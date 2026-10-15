# Bomb Squad 💣

A real-time **cooperative bomb defusal game** that runs entirely in the browser.
One bomb, 1–3 players (humans and/or AI teammates), 150 seconds on the clock —
and nobody holds the whole manual. The only way to win is to *talk to each other*.

- ✂️ **Wires** — cut 5 colored wires in the secret order
- 🔢 **Keypad** — press 4 symbols in the secret sequence
- 🔴 **Button** — follow the 6-rule table: press once, hold 3s, or press twice
- 💥 3 strikes or timeout and it's over
- 🤖 No humans around? Bots join as teammates, share their manual pages in chat, and play fair (they never see your clues)

## How it works (architecture)

```
browser ──WebSocket──▶ Cloudflare Worker ──▶ GameRoom Durable Object ──▶ alarms (1s tick)
   ▲                          │                        │
   │                    /room/<code>/ws          authoritative state
   │                    /api/create              + bot teammates
   └──────── static assets (client/) ◀──────────┘
```

- **`shared/game.js`** — pure game logic (bomb generation, clue dealing, action
  validation, win/lose). Zero platform dependencies; unit-tested with `node --test`.
- **`worker/`** — Cloudflare Worker (routing) + `GameRoom` Durable Object
  (rooms, hibernatable WebSockets, server-authoritative countdown via storage
  alarms, bots).
- **`client/`** — vanilla HTML/CSS/JS. No build step, no framework.
- Full protocol spec: [`docs/protocol.md`](docs/protocol.md) ·
  game rules: [`docs/game-design.md`](docs/game-design.md) ·
  contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Play locally

```bash
npm install
npx wrangler dev
```

Open the printed URL in 2–3 browser tabs (or share your LAN URL), create a
room in one tab, join with the 4-letter code in the others. Add bots from the
lobby if you're short on humans.

Run the tests:

```bash
npm test
```

## Deploy to Cloudflare (via GitHub)

Pushing to `main` deploys automatically (`.github/workflows/deploy.yml`).
First, add two repository secrets — **Settings → Secrets and variables →
Actions → New repository secret**:

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com](https://dash.cloudflare.com) → My Profile → API Tokens → **Create Token** → use the **"Edit Cloudflare Workers"** template |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages → Overview (right sidebar) |

That's it. The workflow installs dependencies, runs the tests, and runs
`npx wrangler deploy`. No tokens are ever committed to the repo — if you need
to rotate one, just update the secret.

To deploy manually:

```bash
npx wrangler deploy
```

## Project status

Early but playable: full game loop, bots, chat, reconnect grace period, and
automated deploys are in. Ideas labeled `good first issue` are the best place
to jump in — a 4th module and sound effects are up for grabs.
