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
