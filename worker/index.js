// worker/index.js — Cloudflare Worker entry point.
//
// Routing:
//   POST /api/create        -> create a room, return { code }
//   WS   /room/<CODE>/ws    -> proxied to the GameRoom Durable Object
//   everything else         -> static client assets (index.html, app.js, ...)

import { GameRoom } from "./room.js";

export { GameRoom };

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeRoomCode() {
  let code = "";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      const code = makeRoomCode();
      const id = env.GAME_ROOMS.idFromName(code);
      const stub = env.GAME_ROOMS.get(id);
      // Touch the DO so the room exists before the first socket arrives.
      await stub.fetch("https://room/init");
      return Response.json({ code });
    }

    const wsMatch = url.pathname.match(/^\/room\/([A-Za-z0-9]{4})\/ws$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const id = env.GAME_ROOMS.idFromName(code);
      const stub = env.GAME_ROOMS.get(id);
      // Forward the upgrade request, tagging the room code for the DO.
      const headers = new Headers(request.headers);
      headers.set("X-Room-Code", code);
      return stub.fetch(new Request(request.url, { method: request.method, headers }));
    }

    return env.ASSETS.fetch(request);
  },
};
