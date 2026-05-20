"use strict";
// Crunch test runner. No dependencies. Run with `node tests.js` from the repo
// root. Exercises the pure logic in script.js (scoring, parser, daily RNG,
// solver, clock formatter). Skips anything that touches the DOM by loading
// script.js inside a vm sandbox with minimal browser stubs, then exfiltrating
// the functions via a globalThis.__T bridge appended to the source.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT_PATH = path.join(__dirname, "script.js");

const stubEl = () => {
  const cl = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  return {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {}, classList: cl,
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, setAttribute() {}, getAttribute() { return null; },
    cloneNode() { return stubEl(); },
    children: [], childNodes: [],
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {},
    hidden: false, textContent: "", innerHTML: "", value: "", disabled: false,
    offsetHeight: 0,
  };
};

const sandbox = {
  document: {
    getElementById: () => stubEl(),
    querySelector: () => stubEl(),
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => stubEl(),
    body: stubEl(),
  },
  localStorage: {
    _: {},
    getItem(k) { return this._[k] ?? null; },
    setItem(k, v) { this._[k] = String(v); },
    removeItem(k) { delete this._[k]; },
  },
  navigator: {},
  Date, Math, JSON, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.addEventListener = function() {};
sandbox.removeEventListener = function() {};

const src = fs.readFileSync(SCRIPT_PATH, "utf8") + `
;globalThis.__T = {
  pointsFor, parseAndEvaluate, tokenize, formatClock,
  seedFromString, mulberry32, solve, TIME_LIMIT_MS,
  setPool(pool) { state.pool = pool; },
};
`;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const T = sandbox.__T;

let pass = 0, fail = 0;
function check(name, cond, expected, actual) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else {
    fail++;
    console.log("  FAIL " + name +
      "\n         expected=" + JSON.stringify(expected) +
      "\n         got=     " + JSON.stringify(actual));
  }
}

console.log("\npointsFor (scoring tiers + speed bonus):");
check("exact + full 5min remaining = 10 (capped at exact ceiling)",
  T.pointsFor(0, 0) === 10, 10, T.pointsFor(0, 0));
check("exact + 4 min used = 3 (60s remaining adds 3 speed pts)",
  T.pointsFor(0, 240_000) === 3, 3, T.pointsFor(0, 240_000));
check("off by 3 + 0s used = 7 (capped at ≤5 tier)",
  T.pointsFor(3, 0) === 7, 7, T.pointsFor(3, 0));
check("off by 8 + 0s used = 5 (capped at ≤10 tier)",
  T.pointsFor(8, 0) === 5, 5, T.pointsFor(8, 0));
check("off by 11 = 0 (outside all tiers)",
  T.pointsFor(11, 0) === 0, 0, T.pointsFor(11, 0));
check("null distance (no guess) = 0",
  T.pointsFor(null, 0) === 0, 0, T.pointsFor(null, 0));
check("exact + timed out = 1 (base point only)",
  T.pointsFor(0, T.TIME_LIMIT_MS) === 1, 1, T.pointsFor(0, T.TIME_LIMIT_MS));

console.log("\nparseAndEvaluate (strict Countdown rules):");
T.setPool([100, 75, 50, 25, 10, 8, 6, 5, 4, 3, 2, 20, 22]);
check("simple add",        T.parseAndEvaluate("100 + 5 + 4") === 109, 109, T.parseAndEvaluate("100 + 5 + 4"));
check("parens + multiply", T.parseAndEvaluate("(75 × 6) + 22") === 472, 472, T.parseAndEvaluate("(75 × 6) + 22"));
check("op precedence",     T.parseAndEvaluate("2 + 3 × 4") === 14, 14, T.parseAndEvaluate("2 + 3 × 4"));
check("subtraction",       T.parseAndEvaluate("100 − 50") === 50, 50, T.parseAndEvaluate("100 − 50"));
check("division (clean)",  T.parseAndEvaluate("100 ÷ 4") === 25, 25, T.parseAndEvaluate("100 ÷ 4"));

let threw = false;
try { T.parseAndEvaluate("10 − 20"); } catch (_) { threw = true; }
check("negative intermediate result is rejected", threw, true, threw);

threw = false;
try { T.parseAndEvaluate("10 ÷ 3"); } catch (_) { threw = true; }
check("non-integer division is rejected", threw, true, threw);

threw = false;
try { T.parseAndEvaluate("100 + 100"); } catch (_) { threw = true; }
check("reusing a tile more than available is rejected", threw, true, threw);

console.log("\nparseAndEvaluate (loose mode for live preview):");
check("loose mode allows negative intermediate",
  T.parseAndEvaluate("10 − 20", { loose: true }) === -10, -10,
  T.parseAndEvaluate("10 − 20", { loose: true }));

console.log("\nformatClock:");
check("5 minutes",     T.formatClock(300_000) === "5:00", "5:00", T.formatClock(300_000));
check("10 seconds",    T.formatClock(10_000) === "0:10", "0:10", T.formatClock(10_000));
check("zero",          T.formatClock(0) === "0:00", "0:00", T.formatClock(0));
check("90 sec = 1:30", T.formatClock(90_000) === "1:30", "1:30", T.formatClock(90_000));

console.log("\nDaily seed (mulberry32 + seedFromString):");
const seed = T.seedFromString("2026-05-20");
const r1 = T.mulberry32(seed);
const r2 = T.mulberry32(seed);
const a = [r1(), r1(), r1()];
const b = [r2(), r2(), r2()];
check("same seed produces same sequence",
  JSON.stringify(a) === JSON.stringify(b), a, b);
check("different seed produces different sequence",
  T.mulberry32(T.seedFromString("2026-05-21"))() !== T.mulberry32(seed)(),
  "different first value", "same first value");

console.log("\nsolve:");
const sol = T.solve([100, 5, 4], 109);
check("solver finds 100+5+4=109 for target 109",
  sol && sol.distance === 0, "distance=0", sol);

console.log("\n" + "─".repeat(48));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
