// shared/game.test.js — unit tests for the PURE game logic.
// Run with: node --test shared/
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WIRE_COLORS,
  KEYPAD_SYMBOLS,
  BUTTON_COLORS,
  BUTTON_LABELS,
  BUTTON_RULES,
  generateBomb,
  dealManualPages,
  expectedButtonAction,
  createGameState,
  applyWireCut,
  applyKeypadPress,
  applyButtonAction,
  isDefused,
} from "./game.js";

// Tiny seeded PRNG so tests are deterministic.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("generateBomb", () => {
  it("produces a full permutation of wire colors for order and display", () => {
    const bomb = generateBomb(mulberry32(1));
    assert.deepEqual([...bomb.wires.order].sort(), [...WIRE_COLORS].sort());
    assert.deepEqual([...bomb.wires.display].sort(), [...WIRE_COLORS].sort());
  });

  it("picks 4 unique keypad symbols from the set of 8", () => {
    const bomb = generateBomb(mulberry32(2));
    assert.equal(bomb.keypad.order.length, 4);
    assert.equal(new Set(bomb.keypad.order).size, 4);
    bomb.keypad.order.forEach((s) => assert.ok(KEYPAD_SYMBOLS.includes(s)));
  });

  it("picks a valid button color, label, and matching expected action", () => {
    const bomb = generateBomb(mulberry32(3));
    assert.ok(BUTTON_COLORS.includes(bomb.button.color));
    assert.ok(BUTTON_LABELS.includes(bomb.button.label));
    assert.equal(bomb.button.expected, expectedButtonAction(bomb.button.color, bomb.button.label));
  });

  it("generates different bombs for different seeds", () => {
    const a = generateBomb(mulberry32(10));
    const b = generateBomb(mulberry32(11));
    assert.notDeepEqual(a.wires.order, b.wires.order);
  });
});

describe("button rule table", () => {
  it("covers all 12 color/label combos with the documented action", () => {
    const expected = {
      "RED/PRESS": "hold", "RED/HOLD": "hold", "RED/ABORT": "double",
      "BLUE/PRESS": "press", "BLUE/HOLD": "press", "BLUE/ABORT": "double",
      "GREEN/PRESS": "hold", "GREEN/HOLD": "press", "GREEN/ABORT": "double",
      "YELLOW/PRESS": "hold", "YELLOW/HOLD": "double", "YELLOW/ABORT": "double",
    };
    for (const color of BUTTON_COLORS) {
      for (const label of BUTTON_LABELS) {
        assert.equal(
          expectedButtonAction(color, label),
          expected[`${color}/${label}`],
          `${color}/${label}`
        );
      }
    }
  });

  it("has 6 uniquely numbered rules", () => {
    assert.deepEqual(BUTTON_RULES.map((r) => r.n), [1, 2, 3, 4, 5, 6]);
  });
});

describe("dealManualPages", () => {
  it("jointly determines the wire order (3 players)", () => {
    const bomb = generateBomb(mulberry32(42));
    const pages = dealManualPages(bomb, 3);
    const facts = pages.flatMap((p) => p.wires);
    assert.equal(facts.length, 5);
    const reconstructed = [...facts].sort((a, b) => a.position - b.position).map((f) => f.color);
    assert.deepEqual(reconstructed, bomb.wires.order);
  });

  it("jointly determines the keypad order and all button rules (3 players)", () => {
    const bomb = generateBomb(mulberry32(42));
    const pages = dealManualPages(bomb, 3);
    const symbols = new Map(pages.flatMap((p) => p.keypad).map((k) => [k.position, k.symbol]));
    assert.equal(symbols.size, 4);
    bomb.keypad.order.forEach((s, i) => assert.equal(symbols.get(i), s));
    const rows = new Set(pages.flatMap((p) => p.button).map((b) => b.n));
    assert.deepEqual([...rows].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });

  it("is fair: no single page reveals the full wire order (3 players)", () => {
    const bomb = generateBomb(mulberry32(42));
    const pages = dealManualPages(bomb, 3);
    pages.forEach((page) => {
      assert.ok(page.wires.length < 5, "one page must not reveal all 5 wire positions");
    });
  });

  it("each player sees exactly 2 keypad positions and 2 button rows (3 players)", () => {
    const bomb = generateBomb(mulberry32(7));
    const pages = dealManualPages(bomb, 3);
    pages.forEach((page) => {
      assert.equal(page.keypad.length, 2);
      assert.equal(page.button.length, 2);
    });
  });

  it("jointly determines everything for 1 and 2 players too", () => {
    for (const n of [1, 2]) {
      const bomb = generateBomb(mulberry32(100 + n));
      const pages = dealManualPages(bomb, n);
      assert.equal(pages.length, n);
      const wireFacts = pages.flatMap((p) => p.wires);
      assert.equal(wireFacts.length, 5);
      const rows = new Set(pages.flatMap((p) => p.button).map((b) => b.n));
      assert.equal(rows.size, 6);
    }
  });
});

describe("action validation", () => {
  it("defuses wires when cut in the secret order", () => {
    const bomb = generateBomb(mulberry32(5));
    const state = createGameState();
    bomb.wires.order.forEach((color) => {
      const idx = bomb.wires.display.indexOf(color);
      const res = applyWireCut(bomb, state, idx);
      assert.equal(res.ok, true);
    });
    assert.equal(state.wiresCut.every(Boolean), true);
  });

  it("strikes on a wrong wire and explodes on the third strike", () => {
    const bomb = generateBomb(mulberry32(5));
    const state = createGameState();
    const wrongIdx = bomb.wires.display.findIndex((c) => c !== bomb.wires.order[0]);
    for (let i = 0; i < 3; i++) {
      const res = applyWireCut(bomb, state, wrongIdx);
      assert.equal(res.ok, false);
      assert.equal(res.strike, true);
    }
    assert.equal(state.over, "exploded");
    assert.equal(state.strikes, 3);
  });

  it("does not strike for re-cutting an already cut wire", () => {
    const bomb = generateBomb(mulberry32(5));
    const state = createGameState();
    const idx = bomb.wires.display.indexOf(bomb.wires.order[0]);
    assert.equal(applyWireCut(bomb, state, idx).ok, true);
    const res = applyWireCut(bomb, state, idx);
    assert.equal(res.ok, false);
    assert.equal(res.strike, undefined);
    assert.equal(state.strikes, 0);
  });

  it("defuses the keypad in order and strikes on a wrong symbol", () => {
    const bomb = generateBomb(mulberry32(6));
    const state = createGameState();
    bomb.keypad.order.slice(0, 3).forEach((s) => {
      assert.equal(applyKeypadPress(bomb, state, s).ok, true);
    });
    const wrong = KEYPAD_SYMBOLS.find((s) => s !== bomb.keypad.order[3]);
    const res = applyKeypadPress(bomb, state, wrong);
    assert.equal(res.strike, true);
    assert.equal(state.strikes, 1);
    assert.equal(applyKeypadPress(bomb, state, bomb.keypad.order[3]).defused, true);
  });

  it("accepts the correct button action for every rule-table row", () => {
    for (const rule of BUTTON_RULES) {
      // find a color/label combo whose FIRST matching rule is this one
      outer: for (const color of BUTTON_COLORS) {
        for (const label of BUTTON_LABELS) {
          if (BUTTON_RULES.find((r) => r.match(color, label)).n !== rule.n) continue;
          const bomb = { button: { color, label, expected: rule.action } };
          const state = createGameState();
          const ms = rule.action === "hold" ? 3100 : 0;
          const res = applyButtonAction(bomb, state, rule.action, ms);
          assert.equal(res.ok, true, `rule ${rule.n} (${color}/${label})`);
          assert.equal(res.defused, true);
          break outer;
        }
      }
    }
  });

  it("strikes on the wrong button action", () => {
    const bomb = { button: { color: "BLUE", label: "PRESS", expected: "press" } };
    const state = createGameState();
    assert.equal(applyButtonAction(bomb, state, "double").strike, true);
    assert.equal(applyButtonAction(bomb, state, "hold", 3100).strike, true);
    assert.equal(state.strikes, 2);
  });

  it("enforces hold timing boundaries (2.0s - 4.5s)", () => {
    const mk = () => ({ button: { color: "RED", label: "HOLD", expected: "hold" } });
    assert.equal(applyButtonAction(mk(), createGameState(), "hold", 1999).strike, true);
    assert.equal(applyButtonAction(mk(), createGameState(), "hold", 2000).ok, true);
    assert.equal(applyButtonAction(mk(), createGameState(), "hold", 4500).ok, true);
    assert.equal(applyButtonAction(mk(), createGameState(), "hold", 4501).strike, true);
  });

  it("reports defused only when all three modules are done", () => {
    const bomb = generateBomb(mulberry32(9));
    const state = createGameState();
    assert.equal(isDefused(state), false);
    bomb.wires.order.forEach((c) => applyWireCut(bomb, state, bomb.wires.display.indexOf(c)));
    assert.equal(isDefused(state), false);
    bomb.keypad.order.forEach((s) => applyKeypadPress(bomb, state, s));
    assert.equal(isDefused(state), false);
    const ms = bomb.button.expected === "hold" ? 3100 : 0;
    applyButtonAction(bomb, state, bomb.button.expected, ms);
    assert.equal(isDefused(state), true);
  });
});
