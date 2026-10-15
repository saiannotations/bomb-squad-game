// client/app.js — vanilla JS, no build step.
//
// Screens: home -> lobby -> game. The server is authoritative: we render
// whatever the {t:"state"} snapshot says, and send {t:"action"} intents.

const $ = (sel) => document.querySelector(sel);

const screens = {
  home: $("#screen-home"),
  lobby: $("#screen-lobby"),
  game: $("#screen-game"),
};

function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("hidden", key !== name);
  }
}

const store = {
  load() {
    try {
      return JSON.parse(sessionStorage.getItem("bombsquad") || "null");
    } catch {
      return null;
    }
  },
  save(data) {
    sessionStorage.setItem("bombsquad", JSON.stringify(data));
  },
  clear() {
    sessionStorage.removeItem("bombsquad");
  },
};

const app = {
  ws: null,
  code: null,
  playerId: null,
  playerName: null,
  isHost: false,
  manual: null, // private manual page {wires,keypad,button}
  state: null, // last {t:"state"} snapshot
};

function wsUrl(code) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/room/${code}/ws`;
}

function connect(code, name, rejoinId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(code));
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Connection timed out."));
    }, 8000);
    ws.onopen = () => {
      clearTimeout(timeout);
      app.ws = ws;
      app.code = code;
      ws.send(JSON.stringify({ t: "join", name, rejoinId }));
      wireSocket(ws);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Could not reach the game server."));
    };
  });
}

function wireSocket(ws) {
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.t) {
      case "state":
        onState(msg);
        break;
      case "tick":
        onTick(msg.remaining);
        break;
      case "chat":
        onChat(msg.from, msg.text);
        break;
      case "manual":
        app.manual = msg.page;
        renderManual();
        break;
      case "result":
        onResult(msg.win, msg.reason);
        break;
      case "error":
        toast(msg.message);
        break;
      default:
        break;
    }
  };
  ws.onclose = () => {
    // The server keeps our slot for a grace period; a reload rejoins.
    if (app.state && app.state.phase === "PLAYING") {
      toast("Disconnected — reload to rejoin the game.");
    }
  };
}

function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    app.ws.send(JSON.stringify(msg));
  }
}

// -- Home screen ------------------------------------------------------------

$("#btn-create").addEventListener("click", async () => {
  const name = readName();
  if (!name) return;
  try {
    const res = await fetch("/api/create", { method: "POST" });
    const { code } = await res.json();
    await joinRoom(code, name, null);
  } catch (err) {
    $("#home-error").textContent = err.message;
  }
});

$("#btn-join").addEventListener("click", async () => {
  const name = readName();
  if (!name) return;
  const code = $("#input-code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    $("#home-error").textContent = "Room codes are 4 letters/digits.";
    return;
  }
  try {
    await joinRoom(code, name, null);
  } catch (err) {
    $("#home-error").textContent = err.message;
  }
});

function readName() {
  const name = $("#input-name").value.trim().slice(0, 20);
  if (!name) {
    $("#home-error").textContent = "Enter your name first.";
    return null;
  }
  $("#home-error").textContent = "";
  app.playerName = name;
  return name;
}

async function joinRoom(code, name, rejoinId) {
  await connect(code, name, rejoinId);
  store.save({ code, name });
  show("lobby");
}

// Rejoin banner if a previous session exists.
(function initRejoin() {
  const prev = store.load();
  if (prev && prev.code) {
    $("#rejoin-code").textContent = prev.code;
    $("#rejoin-banner").classList.remove("hidden");
    $("#input-name").value = prev.name || "";
    $("#btn-rejoin").addEventListener("click", async () => {
      const name = $("#input-name").value.trim().slice(0, 20) || prev.name || "Player";
      try {
        // Reattach to our previous slot using the stored player id.
        await joinRoom(prev.code, name, prev.playerId || null);
      } catch (err) {
        $("#home-error").textContent = err.message;
      }
    });
  }
})();

// -- Lobby -------------------------------------------------------------------

function onState(s) {
  app.state = s;
  if (!app.playerId) {
    // Learn our player id from the player list once our name appears.
    // (Names are unique enough for a party game; the server keys by id.)
    const me = s.players.find((p) => p.name === app.playerName && !p.isBot);
    if (me) {
      app.playerId = me.id;
      app.isHost = !!me.host;
      store.save({ code: app.code, name: app.playerName, playerId: me.id });
    }
  } else {
    const me = s.players.find((p) => p.id === app.playerId);
    app.isHost = !!(me && me.host);
  }

  if (s.phase === "LOBBY") {
    show("lobby");
    renderLobby(s);
  } else {
    show("game");
    renderGame(s);
  }
  // Render any chat history carried by the snapshot.
  if (s.chat) {
    $("#chat-log").innerHTML = "";
    s.chat.forEach((m) => onChat(m.from, m.text, true));
  }
}

function renderLobby(s) {
  $("#lobby-code").textContent = s.code;
  const ul = $("#player-list");
  ul.innerHTML = "";
  s.players.forEach((p) => {
    const li = document.createElement("li");
    const badges = [
      p.isBot ? '<span class="badge bot">bot</span>' : "",
      p.host ? '<span class="badge host">host</span>' : "",
      p.connected === false ? '<span class="badge offline">offline</span>' : "",
    ].join(" ");
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><span>${badges}</span>`;
    ul.appendChild(li);
  });
  $("#btn-start").classList.toggle("hidden", !app.isHost);
  $("#btn-add-bot").disabled = s.players.length >= 3;
}

$("#btn-add-bot").addEventListener("click", () => send({ t: "add_bot" }));
$("#btn-start").addEventListener("click", () => send({ t: "start" }));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// -- Game screen: timer, strikes, bomb ---------------------------------------

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function onTick(remaining) {
  const el = $("#timer");
  el.textContent = fmtTime(remaining);
  el.classList.toggle("low", remaining <= 30);
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const KEYPAD_SYMBOLS = ["Ω", "Ψ", "★", "♠", "♣", "♥", "♦", "✚"];

function renderGame(s) {
  $("#game-code").textContent = s.code;
  onTick(s.remaining != null ? s.remaining : 150);

  const strikes = "✖".repeat(s.strikes) + "○".repeat(Math.max(0, s.maxStrikes - s.strikes));
  $("#strikes").textContent = strikes.split("").join(" ");

  const bomb = $("#bomb");
  bomb.innerHTML = "";

  // Module 1: wires
  const wires = document.createElement("div");
  wires.className = "module" + (s.wires.defused ? " done" : "");
  wires.innerHTML = "<h3>Module 1 — Wires</h3>";
  const wireBox = document.createElement("div");
  wireBox.className = "wires";
  s.wires.display.forEach((color, i) => {
    const w = document.createElement("div");
    w.className = `wire ${color}` + (s.wires.cut[i] ? " cut" : "");
    w.title = s.wires.cut[i] ? `${color} (cut)` : `Cut the ${color} wire`;
    if (!s.wires.cut[i] && !s.wires.defused) {
      w.addEventListener("click", () => send({ t: "action", module: "wires", wire: i }));
    }
    wireBox.appendChild(w);
  });
  wires.appendChild(wireBox);
  bomb.appendChild(wires);

  // Module 2: keypad
  const keypad = document.createElement("div");
  keypad.className = "module" + (s.keypad.defused ? " done" : "");
  keypad.innerHTML = "<h3>Module 2 — Keypad</h3>";
  const keys = document.createElement("div");
  keys.className = "keypad";
  KEYPAD_SYMBOLS.forEach((sym) => {
    const b = document.createElement("button");
    b.className = "key" + (s.keypad.pressed.includes(sym) ? " pressed" : "");
    b.textContent = sym;
    if (!s.keypad.defused) {
      b.addEventListener("click", () => send({ t: "action", module: "keypad", symbol: sym }));
    }
    keys.appendChild(b);
  });
  keypad.appendChild(keys);
  bomb.appendChild(keypad);

  // Module 3: button (interactions land in the next commit)
  const btnMod = document.createElement("div");
  btnMod.className = "module" + (s.button.defused ? " done" : "");
  btnMod.innerHTML = "<h3>Module 3 — Button</h3>";
  const big = document.createElement("button");
  big.id = "big-button";
  big.className = `bigbutton ${s.button.color}`;
  big.textContent = s.button.label;
  big.disabled = s.button.defused;
  btnMod.appendChild(big);
  const bhint = document.createElement("p");
  bhint.className = "hint";
  bhint.textContent = "Click = press · hold = hold 3s · double-click = press twice";
  btnMod.appendChild(bhint);
  bomb.appendChild(btnMod);
  wireButtonInteractions(big);

  renderManual();
}

// -- Manual panel (private!) --------------------------------------------------
// Your manual page arrives in a {t:"manual"} message addressed only to you.
// Never paste the other players' pages — but DO share your own clues.

function renderManual() {
  const body = $("#manual-body");
  if (!app.manual) {
    body.innerHTML = '<p class="hint">Waiting for the game to start…</p>';
    return;
  }
  const m = app.manual;
  body.innerHTML = "";

  const addSection = (title, items, fmt) => {
    const h = document.createElement("h4");
    h.textContent = title;
    body.appendChild(h);
    const ul = document.createElement("ul");
    items.forEach((it) => {
      const li = document.createElement("li");
      li.textContent = fmt(it);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  };

  addSection("Wires", m.wires, (w) => w.text);
  addSection("Keypad", m.keypad, (k) => k.text);
  addSection("Button", m.button, (b) => b.text);
}

// -- Button interactions: click = press, hold = hold 3s, double-click = twice
function wireButtonInteractions(big) {
  if (!big || big.disabled) return;
  let downAt = 0;
  let tapTimer = null;

  big.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    downAt = performance.now();
  });

  big.addEventListener("pointerup", () => {
    const ms = Math.round(performance.now() - downAt);
    if (ms >= 700) {
      // A real hold — report how long it was held.
      send({ t: "action", module: "button", kind: "hold", ms });
      return;
    }
    // A tap: wait briefly to see if it's the first half of a double-tap.
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
      send({ t: "action", module: "button", kind: "double" });
    } else {
      tapTimer = setTimeout(() => {
        tapTimer = null;
        send({ t: "action", module: "button", kind: "press" });
      }, 320);
    }
  });

  big.addEventListener("pointerleave", () => {
    downAt = 0;
  });
}

// -- Chat and result land in the next commit --------------------------------
function onChat() {}
function onResult() {}
