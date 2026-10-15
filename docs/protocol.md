# WebSocket protocol

All messages are JSON. The server is authoritative: clients send *intents*,
the server validates them against the real game state and broadcasts results.

## Client → server

| Message | Meaning |
|---|---|
| `{t:"join", name}` | Join the room (or create your slot). Optional `rejoinId` reattaches to a previous player slot after a disconnect. |
| `{t:"chat", text}` | Post a chat message (max 300 chars). |
| `{t:"add_bot"}` | Add an AI teammate (lobby only, max 3 players total). |
| `{t:"start"}` | Start the game (host only; auto-fills empty slots with bots). |
| `{t:"action", module:"wires", wire:2}` | Cut the wire at display position `2` (0–4). |
| `{t:"action", module:"keypad", symbol:"Ω"}` | Press a keypad symbol. |
| `{t:"action", module:"button", kind:"press"}` | Press the button once. |
| `{t:"action", module:"button", kind:"hold", ms:3100}` | Hold the button; `ms` is how long it was held (must be 2000–4500 for a "hold" rule). |
| `{t:"action", module:"button", kind:"double"}` | Press the button twice. |

## Server → client

| Message | Meaning |
|---|---|
| `{t:"state", ...}` | Full public snapshot, sent on every change. Includes phase (`LOBBY`/`PLAYING`/`WON`/`LOST`), players, strikes, remaining seconds, and module progress. **Never** includes the secret wire order, the secret keypad order, or anyone's manual page. |
| `{t:"tick", remaining}` | Seconds left, broadcast every second while playing. |
| `{t:"chat", from, text}` | A chat message (`from` is a player name or `"SYSTEM"`). |
| `{t:"manual", page}` | **Private.** Your personal manual page: `{wires:[...], keypad:[...], button:[...]}`. Sent only to your socket. |
| `{t:"result", win, reason}` | Final outcome, e.g. `{t:"result", win:true, reason:"All three modules defused."}`. |
| `{t:"error", message}` | Something you tried wasn't allowed (room full, game already started…). |

## Notes for implementers

- The snapshot's `players[].connected` flag tells you who dropped; their slot
  is kept so they can rejoin with `rejoinId`.
- Bots never receive WebSocket messages — they live inside the Durable Object.
- All game rules (strikes, defusal, win/lose) live in `shared/game.js` and are
  unit-tested. The worker only orchestrates.
