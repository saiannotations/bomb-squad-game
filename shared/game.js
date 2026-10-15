// shared/game.js
//
// PURE game logic for Bomb Squad. No platform dependencies:
// no fetch, no WebSocket, no timers. Randomness comes only from the
// injected `rand` function so tests can use a seeded generator.
// Imported by the Cloudflare Worker AND by the node --test unit tests.

export const GAME_DURATION_S = 150;
export const MAX_STRIKES = 3;

export const WIRE_COLORS = ["RED", "BLUE", "GREEN", "YELLOW", "WHITE"];
export const KEYPAD_SYMBOLS = ["Ω", "Ψ", "★", "♠", "♣", "♥", "♦", "✚"];
export const BUTTON_COLORS = ["RED", "BLUE", "GREEN", "YELLOW"];
export const BUTTON_LABELS = ["PRESS", "HOLD", "ABORT"];

// Button rule table. Evaluated top to bottom; the FIRST matching rule wins.
// Every one of the 4 x 3 = 12 color/label combos matches exactly one rule.
export const BUTTON_RULES = [
  { n: 1, condition: "the label is ABORT", match: (color, label) => label === "ABORT", action: "double" },
  { n: 2, condition: "the color is RED and the label is HOLD", match: (color, label) => color === "RED" && label === "HOLD", action: "hold" },
  { n: 3, condition: "the color is BLUE", match: (color, label) => color === "BLUE", action: "press" },
  { n: 4, condition: "the label is PRESS", match: (color, label) => label === "PRESS", action: "hold" },
  { n: 5, condition: "the color is YELLOW", match: (color, label) => color === "YELLOW", action: "double" },
  { n: 6, condition: "anything else", match: () => true, action: "press" },
];

export const BUTTON_ACTION_NAMES = {
  press: "press it once",
  hold: "hold it for 3 seconds",
  double: "press it twice",
};

// Button "hold" must be close to 3 seconds: 2.0s - 4.5s is accepted.
export const HOLD_MIN_MS = 2000;
export const HOLD_MAX_MS = 4500;

function pickOne(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

export function shuffled(arr, rand = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function expectedButtonAction(color, label) {
  return BUTTON_RULES.find((r) => r.match(color, label)).action;
}

// A bomb is three modules:
// - wires: `order` is the secret cut order (colors), `display` is the order
//   the wires are shown on the bomb. Players cut by display position.
// - keypad: `order` is the secret 4-symbol sequence.
// - button: color + label; `expected` is the correct action from the rule table.
export function generateBomb(rand = Math.random) {
  const order = shuffled(WIRE_COLORS, rand);
  const display = shuffled(WIRE_COLORS, rand);
  const keypad = shuffled(KEYPAD_SYMBOLS, rand).slice(0, 4);
  const color = pickOne(BUTTON_COLORS, rand);
  const label = pickOne(BUTTON_LABELS, rand);
  return {
    wires: { order, display },
    keypad: { order: keypad },
    button: { color, label, expected: expectedButtonAction(color, label) },
  };
}

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];

// Deal one private "manual page" per player.
//
// The clues are a PARTITION of the facts: put all pages together and you can
// solve every module, but no single page reveals everything (fair play —
// bots get the same kind of page as humans and never see anyone else's).
//
// - WIRES: the 5 cut positions are split up. 3 players -> {1st}, {5th},
//   {2nd,3rd,4th}. 2 players -> {1st,5th}, {2nd,3rd,4th}. 1 player -> all.
// - KEYPAD: each player learns 2 of the 4 symbol positions (cycling).
// - BUTTON: the 6 rule-table rows are split up. 3 players -> 2 rows each.
export function dealManualPages(bomb, playerCount) {
  const n = Math.max(1, Math.min(3, playerCount));
  const pages = Array.from({ length: n }, () => ({ wires: [], keypad: [], button: [] }));

  const wireSplits = {
    1: [[0, 1, 2, 3, 4]],
    2: [[0, 4], [1, 2, 3]],
    3: [[0], [4], [1, 2, 3]],
  }[n];
  wireSplits.forEach((positions, i) => {
    positions.forEach((p) => {
      const color = bomb.wires.order[p];
      pages[i].wires.push({
        color,
        position: p,
        text: `Cut ${color} ${ORDINALS[p]}.`,
      });
    });
  });

  for (let i = 0; i < n; i++) {
    const positions = n === 1 ? [0, 1, 2, 3] : [(2 * i) % 4, (2 * i + 1) % 4];
    positions.forEach((p) => {
      const symbol = bomb.keypad.order[p];
      pages[i].keypad.push({
        position: p,
        symbol,
        text: `Keypad position ${p + 1} is ${symbol}.`,
      });
    });
  }

  const buttonSplits = {
    1: [[0, 1, 2, 3, 4, 5]],
    2: [[0, 1, 2], [3, 4, 5]],
    3: [[0, 1], [2, 3], [4, 5]],
  }[n];
  buttonSplits.forEach((rows, i) => {
    rows.forEach((r) => {
      const rule = BUTTON_RULES[r];
      pages[i].button.push({
        n: rule.n,
        condition: rule.condition,
        action: rule.action,
        text: `Rule ${rule.n}: if ${rule.condition}, ${BUTTON_ACTION_NAMES[rule.action]}.`,
      });
    });
  });

  return pages;
}
