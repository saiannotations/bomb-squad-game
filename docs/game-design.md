# Game design

## The fantasy

You're a bomb squad. One bomb, one countdown, three modules — and nobody
holds the whole manual. The only way to win is to *talk*.

## Setup

- 1–3 players per room (humans and/or AI bots). The host's room code (4 letters)
  is all you need to join. No accounts, no downloads.
- The host presses Start. Empty slots auto-fill with bots, so the game always
  has 3 participants.
- The server builds a random bomb and deals each player a **private manual page**.

## The modules

### 1. Wires — cut 5 wires in the secret order
Five colored wires. The server picks a secret cut order first, then splits the
5 positions across the manual pages (e.g. you learn "Cut RED 1st", a teammate
learns "Cut WHITE 5th"). Cut them in order. Wrong wire = strike.

### 2. Keypad — press 4 symbols in the secret order
Eight symbols, four in a secret sequence. Each manual page reveals 2 of the 4
positions. Wrong symbol = strike.

### 3. Button — follow the rule table
A colored button labeled PRESS, HOLD, or ABORT. A 6-row rule table maps
(color, label) → action: **press once**, **hold ~3 seconds**, or **press twice**.
Rules are checked top-down; the first match wins. Each manual page shows 2 of
the 6 rows, so the squad has to combine them. Wrong action = strike.

## Win / lose

- **Win:** all three modules defused before time runs out.
- **Lose:** 3 strikes, or the 150-second timer hits zero.

## Bots (AI teammates)

- Added from the lobby ("Add bot") or auto-filled at Start.
- Each bot gets a **real manual page**, dealt exactly like a human's. Bots
  never see other players' pages — that's the fairness rule, and it's
  enforced in code (`dealManualPages` + private `{t:"manual"}` messages).
- Bots share their clues in chat a few seconds after the game starts, react
  when the squad takes a strike, and celebrate a win.
- A solo human + 2 bots is always winnable using only the clues the bots post.

## Design notes

- **Server-authoritative:** the client is a dumb terminal. All validation
  happens in `shared/game.js`, so cheaters can't fake a defusal.
- **Asymmetric information is the game.** The fun isn't the clicking — it's
  three people yelling "wait, my manual says rule 4!" over chat.
- Timer and bot scheduling use Durable Object alarms, not `setTimeout`, so
  the game survives hibernation and stays fair.
