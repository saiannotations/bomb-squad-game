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

// -- Game screen, chat, timer, manual, result land in the next commits --------
function onTick() {}
function onChat() {}
function renderGame() {}
function renderManual() {}
function onResult() {}
function toast() {}
