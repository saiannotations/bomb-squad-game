// worker/room.js — the GameRoom Durable Object.
//
// One instance per room code. Owns the authoritative game state, the
// WebSocket sessions (via hibernatable WebSockets), the countdown timer
// (via storage alarms), and the bot teammates.
//
// Phases: LOBBY -> PLAYING -> WON | LOST

import {
  GAME_DURATION_S,
  MAX_STRIKES,
  generateBomb,
  dealManualPages,
  createGameState,
  applyWireCut,
  applyKeypadPress,
  applyButtonAction,
  isDefused,
  BUTTON_ACTION_NAMES,
} from "../shared/game.js";

const BOT_NAMES = ["Rook-7", "Vex-3", "Pip-9", "Nova-2", "Juno-5", "Kai-8"];
const MAX_PLAYERS = 3;

function uid() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.game = null;
    // Restore state if the DO was evicted and woken back up.
    this.ctx.blockConcurrencyWhile(async () => {
      this.game = (await this.ctx.storage.get("game")) || null;
    });
  }

  // -- HTTP entry: websocket upgrades land here from worker/index.js --------

  async fetch(request) {
    if (request.url.endsWith("/init")) {
      if (!this.game) {
        const code = request.headers.get("X-Room-Code") || "????";
        this.game = this.freshGame(code);
        await this.save();
      }
      return new Response("ok");
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  freshGame(code) {
    return {
      code,
      phase: "LOBBY",
      players: [], // {id,name,isBot,host,connected,disconnectedAt}
      chat: [], // {from,text,at}
      bomb: null,
      pages: {}, // playerId -> manual page (PRIVATE, never broadcast)
      state: null, // createGameState() shape
      endsAt: 0,
      botQueue: [], // [{at,from,text}] scheduled bot chat
      loseReason: null,
    };
  }

  async save() {
    await this.ctx.storage.put("game", this.game);
  }

  // -- WebSocket plumbing ---------------------------------------------------

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // dead socket; close handler cleans up
      }
    }
  }

  // Public snapshot. Secret info (wire order, keypad order, other players'
  // manual pages) is NEVER included — each client only gets its own page
  // via a private {t:"manual"} message.
  snapshot() {
    const g = this.game;
    return {
      t: "state",
      phase: g.phase,
      code: g.code,
      players: g.players.map((p) => ({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        host: p.host,
        connected: p.connected !== false,
      })),
      strikes: g.state ? g.state.strikes : 0,
      maxStrikes: MAX_STRIKES,
      remaining:
        g.phase === "PLAYING" ? Math.max(0, Math.round((g.endsAt - Date.now()) / 1000)) : null,
      duration: GAME_DURATION_S,
      wires: g.bomb
        ? { display: g.bomb.wires.display, cut: g.state.wiresCut, defused: g.state.wiresCut.every(Boolean) }
        : null,
      keypad: g.bomb
        ? { pressed: g.state.keypadPressed, defused: g.state.keypadPressed.length === 4 }
        : null,
      button: g.bomb
        ? { color: g.bomb.button.color, label: g.bomb.button.label, defused: g.state.buttonDone }
        : null,
      chat: g.chat.slice(-50),
      loseReason: g.loseReason,
    };
  }

  broadcastState() {
    this.broadcast(this.snapshot());
  }

  chat(from, text) {
    const g = this.game;
    g.chat.push({ from, text: String(text).slice(0, 300), at: Date.now() });
    if (g.chat.length > 100) g.chat = g.chat.slice(-100);
    this.broadcast({ t: "chat", from, text: String(text).slice(0, 300) });
  }

  sendTo(playerId, msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.id === playerId) {
        try {
          ws.send(data);
        } catch {
          // ignore
        }
      }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() || {};
    try {
      switch (msg.t) {
        case "join":
          await this.onJoin(ws, msg);
          break;
        case "chat":
          if (me.id) this.chat(me.name || "Player", msg.text);
          await this.save();
          break;
        case "add_bot":
          this.onAddBot(me);
          await this.save();
          break;
        case "start":
          await this.onStart(me);
          break;
        case "action":
          await this.onAction(me, msg);
          break;
        default:
          break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ t: "error", message: "Something went wrong." }));
    }
  }

  async webSocketClose(ws) {
    const me = ws.deserializeAttachment() || {};
    const g = this.game;
    if (g && me.id) {
      const p = g.players.find((pl) => pl.id === me.id);
      if (p && !p.isBot) {
        // Grace period: the player object stays, so a reconnect with the
        // same player id reattaches. (Issue #5)
        p.connected = false;
        p.disconnectedAt = Date.now();
        await this.save();
        this.broadcastState();
      }
    }
  }

  async webSocketError(ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  // -- Lobby ----------------------------------------------------------------

  async onJoin(ws, msg) {
    const g = this.game;
    const name = String(msg.name || "Player").slice(0, 20) || "Player";

    // Reconnect: same player id takes over the slot again.
    let player = msg.rejoinId && g.players.find((p) => p.id === msg.rejoinId && !p.isBot);
    if (player) {
      player.connected = true;
      player.disconnectedAt = 0;
      player.name = name;
    } else {
      if (g.phase !== "LOBBY") {
        ws.send(JSON.stringify({ t: "error", message: "That game already started." }));
        ws.close();
        return;
      }
      if (g.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ t: "error", message: "Room is full." }));
        ws.close();
        return;
      }
      player = {
        id: uid(),
        name,
        isBot: false,
        host: g.players.length === 0,
        connected: true,
      };
      g.players.push(player);
    }

    ws.serializeAttachment({ id: player.id, name: player.name, isBot: false, host: player.host });
    if (g.phase !== "LOBBY" && g.pages[player.id]) {
      ws.send(JSON.stringify({ t: "manual", page: g.pages[player.id] }));
    }
    await this.save();
    this.broadcastState();
    this.chat("SYSTEM", `${player.name} joined the room.`);
    await this.save();
  }

  onAddBot(requester) {
    const g = this.game;
    if (!g || g.phase !== "LOBBY" || g.players.length >= MAX_PLAYERS) return;
    const used = new Set(g.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot-${uid().slice(0, 4)}`;
    const bot = { id: uid(), name, isBot: true, host: false, connected: true };
    g.players.push(bot);
    this.broadcastState();
    this.chat(name, "I'm in. Share what your manual says and we'll crack this thing.");
  }

  // -- Game start ------------------------------------------------------------

  async onStart(me) {
    const g = this.game;
    if (!g || g.phase !== "LOBBY") return;
    const player = g.players.find((p) => p.id === me.id);
    if (!player || !player.host) return; // only the host starts

    // Auto-fill empty slots with bots so a game always has 3 participants.
    while (g.players.length < MAX_PLAYERS) {
      const used = new Set(g.players.map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot-${uid().slice(0, 4)}`;
      g.players.push({ id: uid(), name, isBot: true, host: false, connected: true });
    }

    const bomb = generateBomb();
    const pages = dealManualPages(bomb, g.players.length);
    g.bomb = bomb;
    g.pages = {};
    g.players.forEach((p, i) => {
      g.pages[p.id] = pages[i];
    });
    g.state = createGameState();
    g.phase = "PLAYING";
    g.endsAt = Date.now() + GAME_DURATION_S * 1000;
    g.botQueue = this.buildBotScript(g);

    // Private manual pages — one per socket, never broadcast.
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      if (att.id && g.pages[att.id]) {
        try {
          ws.send(JSON.stringify({ t: "manual", page: g.pages[att.id] }));
        } catch {
          // ignore
        }
      }
    }

    await this.save();
    this.broadcastState();
    this.chat("SYSTEM", `The bomb is live. ${GAME_DURATION_S} seconds on the clock. Talk to each other!`);
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  // -- The rest (timer, actions, bots) lands in the next commits ------------
}

// --- Bot teammates ----------------------------------------------------------
// Bots are fair players: each bot only ever sees its OWN manual page
// (dealt by dealManualPages like everyone else). They share what they know
// by posting clue fragments to chat on a schedule, so a solo human plus
// two bots can win using only the posted clues.

const BOT_STRIKE_REACTIONS = [
  "Ouch. Slow down, team — read the manual out loud first.",
  "That was a strike. Let's double-check the next move together.",
  "Careful! Talk it through before anyone touches anything.",
];

const BOT_WIN_LINES = [
  "WE DID IT! Drinks are on me. (I don't drink. Neither do you. Fine.)",
  "Bomb defused! That teamwork was beautiful.",
  "Another day, another bomb. Great work, squad!",
];

const BOT_LOSE_LINES = [
  "Boom. Good try, team — we'll get the next one.",
  "Well... that was loud. Rematch?",
];

function botClueMessages(bot, page) {
  const out = [];
  if (page.wires.length) {
    out.push(`My wires page says: ${page.wires.map((w) => w.text).join(" ")}`);
  }
  page.keypad.forEach((k) => out.push(`Keypad clue from my manual: ${k.text}`));
  if (page.button.length) {
    out.push(
      `Button rules on my page: ${page.button
        .map((b) => `rule ${b.n} (if ${b.condition} -> ${BUTTON_ACTION_NAMES[b.action]})`)
        .join("; ")}`
    );
  }
  return out.map((text) => ({ from: bot.name, text }));
}

// Methods below are monkey-patched onto GameRoom.prototype so the file
// stays organized by commit. (They run in the same class scope.)
Object.assign(GameRoom.prototype, {
  buildBotScript(g) {
    const queue = [];
    const now = Date.now();
    let at = now + 3000;
    for (const bot of g.players.filter((p) => p.isBot)) {
      for (const m of botClueMessages(bot, g.pages[bot.id])) {
        queue.push({ at, from: m.from, text: m.text });
        at += 4000;
      }
    }
    return queue;
  },

  queueBotChat(name, text, delayMs) {
    this.game.botQueue.push({ at: Date.now() + delayMs, from: name, text });
  },

  randomBot() {
    const bots = this.game.players.filter((p) => p.isBot);
    return bots.length ? pick(bots) : null;
  },

  // Server-authoritative 1-second tick. Drives the countdown, the tick
  // broadcast, and all scheduled bot messages. Bare setTimeout is never
  // used for game correctness — alarms survive hibernation.
  async alarm() {
    const g = this.game;
    if (!g || g.phase !== "PLAYING") return;
    const now = Date.now();

    const due = g.botQueue.filter((m) => m.at <= now);
    g.botQueue = g.botQueue.filter((m) => m.at > now);
    for (const m of due) this.chat(m.from, m.text);

    const remaining = Math.max(0, Math.round((g.endsAt - now) / 1000));
    this.broadcast({ t: "tick", remaining });

    if (remaining <= 0) {
      await this.explode("Time ran out.");
      return;
    }
    await this.save();
    await this.ctx.storage.setAlarm(now + 1000);
  },

  async explode(reason) {
    const g = this.game;
    g.phase = "LOST";
    g.loseReason = reason;
    g.state.over = "exploded";
    g.botQueue = [];
    const bot = this.randomBot();
    if (bot) this.chat(bot.name, pick(BOT_LOSE_LINES));
    this.chat("SYSTEM", `💥 BOOM. ${reason}`);
    await this.save();
    this.broadcastState();
    this.broadcast({ t: "result", win: false, reason });
  },

  async winGame() {
    const g = this.game;
    g.phase = "WON";
    g.botQueue = [];
    const bot = this.randomBot();
    if (bot) this.chat(bot.name, pick(BOT_WIN_LINES));
    this.chat("SYSTEM", "✅ Bomb defused with time to spare. Outstanding work, squad.");
    await this.save();
    this.broadcastState();
    this.broadcast({ t: "result", win: true, reason: "All three modules defused." });
  },
});
