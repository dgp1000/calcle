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
    documentElement: stubEl(),
  },
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
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
  parseSolverExpr, tilesInComputeOrder, stepsInComputeOrder,
  buildHintLevels, buildHintText, hintLevelsCount,
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

console.log("\nhint helpers — AST + compute order:");

const ast1 = T.parseSolverExpr("(75 × 6) + 22");
const tiles1 = T.tilesInComputeOrder(ast1);
check("tiles in compute order — text-order matches compute-order case",
  JSON.stringify(tiles1) === JSON.stringify([75, 6, 22]), [75, 6, 22], tiles1);

const ast2 = T.parseSolverExpr("75 + (100 ÷ 4)");
const tiles2 = T.tilesInComputeOrder(ast2);
check("tiles in compute order — nested paren after lone tile (the critical case)",
  JSON.stringify(tiles2) === JSON.stringify([100, 4, 75]), [100, 4, 75], tiles2);

const ast3 = T.parseSolverExpr("(75 × 6) + (22 + 5)");
const tiles3 = T.tilesInComputeOrder(ast3);
check("tiles in compute order — two paren groups at root",
  JSON.stringify(tiles3) === JSON.stringify([75, 6, 22, 5]), [75, 6, 22, 5], tiles3);

const ast4 = T.parseSolverExpr("100 + 8");
const tiles4 = T.tilesInComputeOrder(ast4);
check("tiles in compute order — flat 2-tile solution",
  JSON.stringify(tiles4) === JSON.stringify([100, 8]), [100, 8], tiles4);

const steps1 = T.stepsInComputeOrder(ast1);
check("steps in compute order — basic 3-tile solution",
  JSON.stringify(steps1) === JSON.stringify(["75 × 6 = 450", "450 + 22 = 472"]),
  ["75 × 6 = 450", "450 + 22 = 472"], steps1);

const steps2 = T.stepsInComputeOrder(ast2);
check("steps in compute order — running totals reflect inner-first evaluation",
  JSON.stringify(steps2) === JSON.stringify(["100 ÷ 4 = 25", "75 + 25 = 100"]),
  ["100 ÷ 4 = 25", "75 + 25 = 100"], steps2);

console.log("\nhint helpers — level builder:");

const SOL = "(75 × 6) + 22";
const levels = T.buildHintLevels(SOL);
check("3-tile solution produces exactly 7 hint levels (tiles + start-with + steps + full)",
  levels.length === 7, 7, levels.length);
check("level 1 reveals first tile with consistent phrasing",
  levels[0] === "The tiles used in this order: 75.",
  "The tiles used in this order: 75.", levels[0]);
check("level 2 shows two tiles with the same phrasing",
  levels[1] === "The tiles used in this order: 75, 6.",
  "The tiles used in this order: 75, 6.", levels[1]);
check("level 3 shows all tiles cumulatively with the same phrasing",
  levels[2] === "The tiles used in this order: 75, 6, 22.",
  "The tiles used in this order: 75, 6, 22.", levels[2]);
check("level 4 reveals the first operation expression (no result)",
  levels[3] === "Start with: 75 × 6.",
  "Start with: 75 × 6.", levels[3]);
check("level 5 reveals the first step with its result",
  levels[4] === "75 × 6 = 450.",
  "75 × 6 = 450.", levels[4]);
check("level 6 reveals the running-total step",
  levels[5] === "450 + 22 = 472.",
  "450 + 22 = 472.", levels[5]);
check("level 7 reveals the full expression with the answer",
  levels[6] === "Full solution: (75 × 6) + 22 = 472.",
  "Full solution: (75 × 6) + 22 = 472.", levels[6]);

const levels4 = T.buildHintLevels("((75 × 6) + 22) − 7");
check("4-tile solution produces 9 hint levels",
  levels4.length === 9, 9, levels4.length);
check("4-tile last level shows the full nested expression",
  levels4[8] === "Full solution: ((75 × 6) + 22) − 7 = 465.",
  "Full solution: ((75 × 6) + 22) − 7 = 465.", levels4[8]);

const levels2 = T.buildHintLevels("100 + 8");
check("2-tile solution produces 4 hint levels (no redundant 'full' level)",
  levels2.length === 4, 4, levels2.length);
check("2-tile last level is the step itself — same as the full expression",
  levels2[3] === "100 + 8 = 108.",
  "100 + 8 = 108.", levels2[3]);

check("buildHintText delegates to the level list",
  T.buildHintText(4, SOL) === "Start with: 75 × 6.",
  "Start with: 75 × 6.", T.buildHintText(4, SOL));
check("hintLevelsCount returns level count without recomputing text",
  T.hintLevelsCount(SOL) === 7, 7, T.hintLevelsCount(SOL));
check("hintLevelsCount on null solution returns 0",
  T.hintLevelsCount(null) === 0, 0, T.hintLevelsCount(null));

console.log("\n" + "─".repeat(48));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
