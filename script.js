"use strict";

const TIME_LIMIT_MS = 300_000;
const WARN_AT_MS = 100_000;
const DANGER_AT_MS = 50_000;

const LARGE_POOL = [25, 50, 75, 100];
const LARGE_COUNT = 2;
const SMALL_COUNT = 4;

const OPS = {
  "+": (a, b) => a + b,
  "−": (a, b) => a - b,
  "×": (a, b) => a * b,
  "÷": (a, b) => a / b,
};
const OP_CHARS = "+−×÷";

// --- Daily-puzzle plumbing ---
const STORAGE_KEY = "calcle:state";

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function msUntilLocalMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next - now;
}

function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function defaultStats() {
  return { currentStreak: 0, maxStreak: 0, streakLastDay: null, gamesPlayed: 0, wins: 0, totalPoints: 0 };
}

// Tiered Countdown-style scoring with a speed bonus. Accuracy sets the ceiling
// (10 exact / 7 within 5 / 5 within 10 / else 0); within each tier, each unused
// 30-second bucket adds one point. Solve fast and accurate to hit the cap.
function pointsFor(distance, timeUsedMs) {
  if (distance == null) return 0;
  let cap;
  if (distance === 0) cap = 10;
  else if (distance <= 5) cap = 7;
  else if (distance <= 10) cap = 5;
  else return 0;
  const remainingMs = Math.max(0, TIME_LIMIT_MS - (timeUsedMs ?? TIME_LIMIT_MS));
  const speedPts = Math.floor(remainingMs / 30_000) + 1;
  return Math.min(cap, speedPts);
}

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Migrate legacy shape ({date, result}) → ({lastPlayed, stats}).
    if (data.date && data.result && !data.lastPlayed) {
      return {
        lastPlayed: { date: data.date, result: data.result },
        stats: defaultStats(),
      };
    }
    if (!data.stats) data.stats = defaultStats();
    if (data.stats.totalPoints == null) data.stats.totalPoints = 0;
    return data;
  } catch (_) { return null; }
}

function saveStored(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch (_) { /* localStorage unavailable; non-fatal */ }
}

function yesterdayKey(todayK) {
  const [y, m, d] = todayK.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}

let rng = Math.random;

// --- DOM ---
const targetEl        = document.getElementById("target");
const currentEl       = document.getElementById("current");
const timerBar        = document.getElementById("timerBar");
const timerReadout    = document.getElementById("timerReadout");
const startArea       = document.getElementById("startArea");
const startBtn        = document.getElementById("startBtn");
const lockedNotice    = document.getElementById("lockedNotice");
const lockedSummary   = document.getElementById("lockedSummary");
const lockedSolution  = document.getElementById("lockedSolution");
const lockedShareBtn  = document.getElementById("lockedShareBtn");
const lockedCountdown = document.getElementById("lockedCountdown");
const numbersRow      = document.getElementById("numbersRow");
const exprInput       = document.getElementById("exprInput");
const statusEl        = document.getElementById("status");
const backspaceBtn    = document.getElementById("backspaceBtn");
const resetBtn        = document.getElementById("resetBtn");
const submitBtn       = document.getElementById("submitBtn");
const endModal        = document.getElementById("endModal");
const endTitle        = document.getElementById("endTitle");
const endMessage      = document.getElementById("endMessage");
const endSolution     = document.getElementById("endSolution");
const endStats        = document.getElementById("endStats");
const lockedStats     = document.getElementById("lockedStats");
const newGameBtn      = document.getElementById("newGameBtn");
const shareBtn        = document.getElementById("shareBtn");
const endShareBar     = document.getElementById("endShareBar");
const lockedShareBar  = document.getElementById("lockedShareBar");
const opButtons       = Array.from(document.querySelectorAll(".op-btn"));

// Build the timer bar once. 60 cells regardless of round length — each cell
// represents an equal slice of the total time (5s per cell at 5min limit).
const TIMER_CELLS = 60;
const MS_PER_CELL = TIME_LIMIT_MS / TIMER_CELLS;
const timerCells = [];
for (let i = 0; i < TIMER_CELLS; i++) {
  const c = document.createElement("div");
  c.className = "cell";
  timerBar.appendChild(c);
  timerCells.push(c);
}

// --- State ---
let state;
let tickHandle = null;
let countdownHandle = null;

function newPuzzle({ devRandom = false } = {}) {
  if (tickHandle) { clearTimeout(tickHandle); tickHandle = null; }
  if (countdownHandle) { clearInterval(countdownHandle); countdownHandle = null; }

  const today = todayKey();
  rng = devRandom
    ? mulberry32(Math.floor(Math.random() * 0x7fffffff))
    : mulberry32(seedFromString(today));

  const pool = [];
  const largeShuffle = shuffle([...LARGE_POOL]);
  for (let i = 0; i < LARGE_COUNT; i++) pool.push(largeShuffle[i]);
  const smallPool = [];
  for (let n = 1; n <= 10; n++) { smallPool.push(n, n); }
  const smallShuffle = shuffle(smallPool);
  for (let i = 0; i < SMALL_COUNT; i++) pool.push(smallShuffle[i]);
  shuffleInPlace(pool);

  const target = 100 + Math.floor(rng() * 900);

  const stored = loadStored();
  const alreadyPlayed = stored && stored.lastPlayed && stored.lastPlayed.date === today;
  const stats = (stored && stored.stats) || defaultStats();

  state = {
    pool,
    expression: "",
    target,
    phase: alreadyPlayed ? "locked" : "idle",
    endTimeMs: 0,
    msLeft: TIME_LIMIT_MS,
    result: alreadyPlayed ? stored.lastPlayed.result : null,
    stats,
  };

  exprInput.value = "";
  endModal.hidden = true;
  startArea.hidden = false;
  setStatus("");

  if (alreadyPlayed) {
    showLockedInline();
  } else {
    startBtn.hidden = false;
    lockedNotice.hidden = true;
  }

  render();
  renderTimer(TIME_LIMIT_MS);
}

function shuffle(arr) { const a = arr.slice(); shuffleInPlace(a); return a; }
function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function showLockedInline() {
  startArea.hidden = false;
  startBtn.hidden = true;
  lockedNotice.hidden = false;
  const r = state.result;
  if (r && r.kind === "noanswer") {
    lockedSummary.textContent = "You didn't submit a valid answer. (0/10)";
  } else if (r && r.distance != null) {
    const pts = r.points != null ? r.points : pointsFor(r.distance, r.timeUsedMs);
    let off;
    if (r.distance === 0) {
      const clock = r.timeUsedMs != null ? formatClock(r.timeUsedMs) : null;
      off = clock != null ? `exact hit in ${clock} 🎯` : "exact hit 🎯";
    } else {
      off = `off by ${r.distance}`;
    }
    lockedSummary.textContent = `${pts}/10 — ${r.exprText} = ${r.result} (${off})`;
  } else {
    lockedSummary.textContent = "";
  }
  renderSolution(lockedSolution, r);
  renderShareBars();
  renderStats(lockedStats);
  startCountdownTicker();
}

function startCountdownTicker() {
  if (countdownHandle) clearInterval(countdownHandle);
  const update = () => {
    const ms = msUntilLocalMidnight();
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    lockedCountdown.textContent =
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (ms <= 0) {
      clearInterval(countdownHandle);
      countdownHandle = null;
      // Cross-midnight: reload to pick up the new puzzle
      newPuzzle();
    }
  };
  update();
  countdownHandle = setInterval(update, 1000);
}

// --- Round lifecycle ---
function startRound() {
  if (state.phase !== "idle") return;
  state.phase = "running";
  state.startTimeMs = Date.now();
  state.endTimeMs = state.startTimeMs + TIME_LIMIT_MS;
  startArea.hidden = true;
  setStatus("");
  scheduleTick();
  render();
  exprInput.focus();
}

function scheduleTick() {
  if (tickHandle) clearTimeout(tickHandle);
  tickHandle = setTimeout(tick, 100);
}

function tick() {
  if (state.phase !== "running") return;
  const remaining = Math.max(0, state.endTimeMs - Date.now());
  state.msLeft = remaining;
  renderTimer(remaining);
  if (remaining === 0) {
    timeUp();
  } else {
    tickHandle = setTimeout(tick, 100);
  }
}

function timeUp() {
  if (state.phase !== "running") return;
  state.phase = "ended";
  let result = null;
  let error = null;
  if (state.expression.trim()) {
    try { result = parseAndEvaluate(state.expression); }
    catch (err) { error = err.message; }
  }
  finishRound(result, true, error);
}

function submitGuess() {
  if (state.phase !== "running") return;
  let result;
  try { result = parseAndEvaluate(state.expression); }
  catch (err) { setStatus(err.message, "error"); return; }
  const timeUsedMs = Date.now() - state.startTimeMs;
  if (tickHandle) { clearTimeout(tickHandle); tickHandle = null; }
  state.phase = "ended";
  finishRound(result, false, null, timeUsedMs);
}

function finishRound(result, byTimeout, parseError, timeUsedMs = TIME_LIMIT_MS) {
  const exprText = state.expression.replace(/=.*/, "").trim();
  let title, message;
  state.phase = "locked";

  let points = 0;
  if (result === null) {
    state.result = { kind: "noanswer", points: 0, timeUsedMs };
    title = "Time's up";
    message = parseError
      ? `No valid answer (${parseError})`
      : "You didn't submit an expression.";
  } else {
    const distance = Math.abs(result - state.target);
    points = pointsFor(distance, timeUsedMs);
    state.result = { exprText, result, distance, byTimeout, timeUsedMs, points };
    const clock = formatClock(timeUsedMs);
    if (distance === 0) {
      const praise = byTimeout
        ? "Just in time"
        : points === 10 ? "Lightning fast"
        : points >= 8   ? "Brilliant"
        : points >= 5   ? "Nice one"
        : points >= 3   ? "You got there"
        : "Cut it close";
      title = `${praise}! 🎯`;
      message = `${points}/10 — solved in ${clock}.\n${exprText} = ${result}`;
    } else if (distance <= 5) {
      title = byTimeout ? "Time's up — so close!" : "So close!";
      message = `${points}/10 — ${exprText} = ${result} (off by ${distance})`;
    } else if (distance <= 10) {
      title = byTimeout ? "Time's up" : "Close-ish";
      message = `${points}/10 — ${exprText} = ${result} (off by ${distance}, target was ${state.target})`;
    } else {
      title = byTimeout ? "Time's up" : "Not quite";
      message = `${points}/10 — ${exprText} = ${result} (off by ${distance}, target was ${state.target})`;
    }
  }
  // Compute solution once for non-exact rounds; cache on state.result.
  if (!state.result || state.result.distance !== 0) {
    const sol = solve(state.pool, state.target);
    if (sol && sol.distance === 0) state.result.solutionExpr = sol.expr;
  }
  endTitle.textContent = title;
  endMessage.textContent = message + "\n\nCome back tomorrow to play again.";
  renderSolution(endSolution, state.result);
  renderShareBars();
  endModal.hidden = false;

  // Update stats. Streak tracks exact hits only; totalPoints accumulates speed-based scores.
  const today = todayKey();
  const won = !!(state.result && state.result.distance === 0);
  const prev = state.stats || defaultStats();
  const newStats = {
    gamesPlayed: prev.gamesPlayed + 1,
    wins: prev.wins + (won ? 1 : 0),
    totalPoints: (prev.totalPoints || 0) + points,
    currentStreak: won
      ? (prev.streakLastDay === yesterdayKey(today) ? prev.currentStreak + 1 : 1)
      : 0,
    maxStreak: prev.maxStreak,
    streakLastDay: won ? today : null,
  };
  newStats.maxStreak = Math.max(prev.maxStreak, newStats.currentStreak);
  state.stats = newStats;

  saveStored({
    lastPlayed: { date: today, result: state.result },
    stats: newStats,
  });
  renderStats(endStats);
  showLockedInline();
  render();
}

function renderSolution(container, result) {
  if (!container) return;
  // Show solution for any non-exact result (including no-answer). Hide on exact wins.
  if (!result || result.distance === 0) {
    container.innerHTML = "";
    return;
  }
  let expr = result.solutionExpr;
  if (!expr) {
    const sol = solve(state.pool, state.target);
    if (sol && sol.distance === 0) {
      expr = sol.expr;
      result.solutionExpr = expr;
    }
  }
  if (expr) {
    container.innerHTML = `<span class="lbl">A possible solution</span><span class="expr">${expr} = ${state.target}</span>`;
  } else {
    container.innerHTML = `<span class="lbl">No exact solution exists for this puzzle.</span>`;
  }
}

function renderStats(container) {
  if (!container) return;
  const s = state.stats || defaultStats();
  const avg = s.gamesPlayed ? ((s.totalPoints || 0) / s.gamesPlayed).toFixed(1) : "0";
  container.innerHTML = "";
  const cells = [
    { num: s.currentStreak, lbl: "Streak", streak: true },
    { num: s.maxStreak,     lbl: "Best",   streak: true },
    { num: s.gamesPlayed,   lbl: "Played" },
    { num: avg,             lbl: "Avg pts" },
  ];
  for (const c of cells) {
    const cell = document.createElement("div");
    cell.className = "stat" + (c.streak ? " streak" : "");
    const n = document.createElement("div");
    n.className = "num";
    n.textContent = String(c.num);
    const l = document.createElement("div");
    l.className = "lbl";
    l.textContent = c.lbl;
    cell.appendChild(n);
    cell.appendChild(l);
    container.appendChild(cell);
  }
}

// --- Expression building (append helpers) ---
function lastNonSpace(s) {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] !== " ") return s[i];
  return "";
}

function appendNumber(n) {
  if (state.phase !== "running") return;
  const e = state.expression;
  const last = lastNonSpace(e);
  if (e === "") {
    setExpression(String(n));
    return;
  }
  if (last === "(" || OP_CHARS.includes(last)) {
    setExpression(e.endsWith(" ") ? e + n : e + " " + n);
    return;
  }
  // last is a digit or ')'
  setStatus("Add an operator before another number.", "error");
}

function appendOp(op) {
  if (state.phase !== "running") return;
  let e = state.expression.replace(/\s+$/, "");
  const last = lastNonSpace(e);

  if (op === "(") {
    if (e === "" || last === "(" || OP_CHARS.includes(last)) {
      e = e === "" ? "(" : e + " (";
    } else {
      e = e + " × (";
    }
    setExpression(e);
    return;
  }
  if (op === ")") {
    if (last === "" || last === "(" || OP_CHARS.includes(last)) {
      setStatus("Can't close — nothing to close.", "error");
      return;
    }
    if (countParens(e) <= 0) {
      setStatus("No '(' to match.", "error");
      return;
    }
    setExpression(e + ")");
    return;
  }
  if (e === "" || last === "(") {
    setStatus("Need a number before an operator.", "error");
    return;
  }
  if (OP_CHARS.includes(last)) {
    e = e.slice(0, -1).replace(/\s+$/, "") + " " + op;
  } else {
    e = e + " " + op;
  }
  setExpression(e);
}

function countParens(e) {
  let open = 0;
  for (const c of e) {
    if (c === "(") open++;
    else if (c === ")") open--;
  }
  return open;
}

function backspace() {
  if (state.phase !== "running") return;
  let e = state.expression.replace(/\s+$/, "");
  if (e === "") return;
  const m = e.match(/^(.*?)(\s*)(\d+|[()+−×÷])$/);
  setExpression(m ? m[1].replace(/\s+$/, "") : "");
}

function clearExpression() {
  if (state.phase !== "running") return;
  setExpression("");
}

function setExpression(e) {
  state.expression = e;
  exprInput.value = e;
  setStatus("");
  render();
}

// --- Tokenizer / parser ---
function tokenize(input) {
  const eq = input.indexOf("=");
  if (eq >= 0) input = input.slice(0, eq);

  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      tokens.push({ type: "NUM", value: parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    let op = c;
    if (op === "*" || op === "x" || op === "X") op = "×";
    if (op === "/") op = "÷";
    if (op === "-") op = "−";
    if (op === "(" || op === ")") {
      tokens.push({ type: "PAREN", value: op });
    } else if (OP_CHARS.includes(op)) {
      tokens.push({ type: "OP", value: op });
    } else {
      throw new Error(`Unexpected character: "${c}"`);
    }
    i++;
  }
  return tokens;
}

function parseAndEvaluate(input) {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error("Expression is empty.");

  const poolCounts = new Map();
  for (const v of state.pool) poolCounts.set(v, (poolCounts.get(v) || 0) + 1);
  const usedCounts = new Map();
  for (const t of tokens) {
    if (t.type === "NUM") usedCounts.set(t.value, (usedCounts.get(t.value) || 0) + 1);
  }
  for (const [v, used] of usedCounts) {
    const avail = poolCounts.get(v) || 0;
    if (avail === 0) throw new Error(`Number ${v} isn't in this puzzle.`);
    if (used > avail) throw new Error(`You used ${v} ${used} times, but only ${avail} available.`);
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseFactor() {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression.");
    if (t.type === "NUM") { consume(); return t.value; }
    if (t.type === "PAREN" && t.value === "(") {
      consume();
      const v = parseExpr();
      const close = peek();
      if (!close || close.value !== ")") throw new Error("Missing ')'.");
      consume();
      return v;
    }
    throw new Error(`Unexpected token: "${t.value}".`);
  }
  function parseTerm() {
    let left = parseFactor();
    while (true) {
      const t = peek();
      if (!t || t.type !== "OP" || (t.value !== "×" && t.value !== "÷")) break;
      consume();
      const right = parseFactor();
      left = applyOp(left, t.value, right);
    }
    return left;
  }
  function parseExpr() {
    let left = parseTerm();
    while (true) {
      const t = peek();
      if (!t || t.type !== "OP" || (t.value !== "+" && t.value !== "−")) break;
      consume();
      const right = parseTerm();
      left = applyOp(left, t.value, right);
    }
    return left;
  }
  function applyOp(a, op, b) {
    if (op === "÷" && b === 0) throw new Error("Division by zero.");
    const r = OPS[op](a, b);
    if (op === "÷" && !Number.isInteger(r)) throw new Error(`Division must be whole (${a} ÷ ${b} = ${r}).`);
    if (r < 0) throw new Error(`Intermediate result can't be negative (${a} ${op} ${b} = ${r}).`);
    return r;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected token: "${tokens[pos].value}".`);
  return result;
}

// --- Solver: bitmask DP over tile subsets. ---
// Returns { value, expr, distance } for the closest reachable value (exact if possible).
function solve(pool, target) {
  const n = pool.length;
  const sets = new Array(1 << n);
  for (let i = 0; i < n; i++) {
    const m = new Map();
    m.set(pool[i], String(pool[i]));
    sets[1 << i] = m;
  }
  let best = { value: pool[0], expr: String(pool[0]), distance: Math.abs(pool[0] - target) };
  const consider = (v, e) => {
    const d = Math.abs(v - target);
    if (d < best.distance) best = { value: v, expr: e, distance: d };
  };
  for (const v of pool) consider(v, String(v));

  const popcount = x => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };
  const subsets = [];
  for (let s = 1; s < (1 << n); s++) if (popcount(s) >= 2) subsets.push(s);
  subsets.sort((a, b) => popcount(a) - popcount(b));

  const tryCombo = (m, r, e) => {
    if (!m.has(r)) m.set(r, e);
    consider(r, e);
  };

  for (const s of subsets) {
    const m = new Map();
    // Iterate non-empty proper subsets of s; each unordered partition appears twice (a, s\a) and (s\a, a),
    // which is fine — duplicate work is bounded and Map dedupes results.
    for (let a = (s - 1) & s; a > 0; a = (a - 1) & s) {
      const b = s ^ a;
      const ma = sets[a];
      const mb = sets[b];
      if (!ma || !mb) continue;
      for (const [va, ea] of ma) {
        for (const [vb, eb] of mb) {
          tryCombo(m, va + vb, `(${ea} + ${eb})`);
          tryCombo(m, va * vb, `(${ea} × ${eb})`);
          if (va > vb) tryCombo(m, va - vb, `(${ea} − ${eb})`);
          else if (vb > va) tryCombo(m, vb - va, `(${eb} − ${ea})`);
          if (vb !== 0 && va % vb === 0 && va !== 0)
            tryCombo(m, va / vb, `(${ea} ÷ ${eb})`);
          if (va !== 0 && vb % va === 0 && vb !== 0)
            tryCombo(m, vb / va, `(${eb} ÷ ${ea})`);
        }
      }
    }
    sets[s] = m;
    if (best.distance === 0) break;
  }
  best.expr = stripOuterParens(best.expr);
  return best;
}

function stripOuterParens(e) {
  if (!(e.startsWith("(") && e.endsWith(")"))) return e;
  let depth = 0;
  for (let i = 0; i < e.length - 1; i++) {
    if (e[i] === "(") depth++;
    else if (e[i] === ")") depth--;
    if (depth === 0) return e;
  }
  return e.slice(1, -1);
}

// --- Share ---
function buildShareBar() {
  const r = state && state.result;
  const pts = !r ? 0
            : r.points != null ? r.points
            : r.distance != null ? pointsFor(r.distance, r.timeUsedMs)
            : 0;
  // For 0 pts, show the full row as black so the band is still visible.
  if (pts === 0) return "⬛".repeat(10);
  // Color band reflects speed: 8-10 green, 4-7 yellow, 1-3 orange.
  const filledGlyph = pts >= 8 ? "🟩" : pts >= 4 ? "🟨" : "🟧";
  return filledGlyph.repeat(pts) + "⬜".repeat(10 - pts);
}

function buildShareText() {
  const r = state && state.result;
  const date = todayKey();
  const bar = buildShareBar();
  if (!r || r.kind === "noanswer") {
    return `Calcle ${date} — 0/10 (no answer)\n${bar}`;
  }
  const dist = r.distance;
  const pts = pointsFor(dist, r.timeUsedMs);
  const clock = formatClock(r.timeUsedMs ?? TIME_LIMIT_MS);
  const headline = dist === 0
    ? `${pts}/10 🎯 in ${clock}`
    : `${pts}/10 (off by ${dist}, ${clock})`;
  return `Calcle ${date} — ${headline}\n${bar}`;
}

function renderShareBars() {
  const bar = buildShareBar();
  if (endShareBar) endShareBar.textContent = bar;
  if (lockedShareBar) lockedShareBar.textContent = bar;
}

async function shareResult(btn) {
  const text = buildShareText();
  const url = location.href.split("?")[0].split("#")[0];

  // Native share sheet (iOS, Android, modern desktop) — lets the user pick
  // Messages / WhatsApp / Mail / etc.
  if (navigator.share) {
    try {
      await navigator.share({ title: "Calcle", text, url });
      return;
    } catch (err) {
      // User dismissed the sheet — bail quietly.
      if (err && err.name === "AbortError") return;
      // Any other error: fall through to clipboard.
    }
  }

  // Clipboard fallback (desktop Firefox, anything without Web Share).
  const clipText = `${text}\n${url}`;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(clipText);
      ok = true;
    }
  } catch (_) { /* fall through */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = clipText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (_) { ok = false; }
  }
  if (btn) {
    const original = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
}

// --- Rendering ---
function render() {
  targetEl.textContent = String(state.target);
  renderTiles();
  renderControls();
  renderCurrent();
}

function formatClock(ms) {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderTimer(ms) {
  const running = state && state.phase === "running";
  const idle = state && state.phase === "idle";
  // On idle (pre-round) show a full green bar; once the round ends/locks, show the bar empty.
  const cellsLit = running ? Math.max(0, Math.ceil(ms / MS_PER_CELL))
                 : idle    ? TIMER_CELLS
                 :           0;
  const readoutMs = running ? ms : (idle ? TIME_LIMIT_MS : 0);
  timerReadout.textContent = formatClock(readoutMs);
  const danger = running && ms <= DANGER_AT_MS;
  const warn = running && ms <= WARN_AT_MS && ms > DANGER_AT_MS;
  timerBar.classList.toggle("danger", danger);
  for (let i = 0; i < TIMER_CELLS; i++) {
    const on = i < cellsLit;
    const cell = timerCells[i];
    cell.classList.toggle("on", on);
    cell.classList.toggle("warn", on && warn);
    cell.classList.toggle("danger", on && danger);
  }
}

function renderCurrent() {
  if (!state || state.phase !== "running" || !state.expression.trim()) {
    currentEl.textContent = "—";
    currentEl.classList.remove("has-value", "match");
    return;
  }
  let value;
  try { value = parseAndEvaluate(state.expression); }
  catch (_) {
    currentEl.textContent = "—";
    currentEl.classList.remove("has-value", "match");
    return;
  }
  currentEl.textContent = String(value);
  currentEl.classList.add("has-value");
  currentEl.classList.toggle("match", value === state.target);
}

function renderTiles() {
  numbersRow.innerHTML = "";
  if (state.phase === "idle") {
    for (let i = 0; i < state.pool.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tile hidden-tile";
      btn.disabled = true;
      btn.textContent = "?";
      numbersRow.appendChild(btn);
    }
    return;
  }
  const usedCounts = (() => {
    const c = new Map();
    const nums = state.expression.match(/\d+/g) || [];
    for (const n of nums) {
      const v = parseInt(n, 10);
      c.set(v, (c.get(v) || 0) + 1);
    }
    return c;
  })();
  const seen = new Map();
  state.pool.forEach(value => {
    const k = (seen.get(value) || 0) + 1;
    seen.set(value, k);
    const used = k <= (usedCounts.get(value) || 0);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tile";
    if (used) btn.classList.add("used");
    btn.disabled = state.phase !== "running";
    btn.textContent = String(value);
    btn.addEventListener("click", () => appendNumber(value));
    numbersRow.appendChild(btn);
  });
}

function renderControls() {
  const empty = state.expression.trim() === "";
  const running = state.phase === "running";
  backspaceBtn.disabled = !running || empty;
  resetBtn.disabled     = !running || empty;
  submitBtn.disabled    = !running || empty;
  exprInput.disabled    = !running;
  opButtons.forEach(b => { b.disabled = !running; });
}

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.classList.remove("error", "ok");
  if (kind) statusEl.classList.add(kind);
}

// --- Wire-up ---
startBtn.addEventListener("click", startRound);
opButtons.forEach(b => b.addEventListener("click", () => appendOp(b.dataset.op)));
backspaceBtn.addEventListener("click", backspace);
resetBtn.addEventListener("click", clearExpression);
submitBtn.addEventListener("click", submitGuess);
newGameBtn.addEventListener("click", () => { endModal.hidden = true; });
shareBtn.addEventListener("click", () => shareResult(shareBtn));
lockedShareBtn.addEventListener("click", () => shareResult(lockedShareBtn));
endModal.addEventListener("click", e => {
  if (e.target === endModal) endModal.hidden = true;
});

exprInput.addEventListener("input", e => {
  state.expression = e.target.value;
  setStatus("");
  render();
});
exprInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitGuess();
  }
});

// Dev reset: Cmd+Option+S (Mac) / Ctrl+Alt+S (others) clears the daily lock
// AND re-rolls with a random seed so you get a fresh puzzle each time.
function devReset() {
  localStorage.removeItem(STORAGE_KEY);
  newPuzzle({ devRandom: true });
}

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyS") {
    e.preventDefault();
    devReset();
  }
});

// Tap-friendly reset: triple-tap the "Calcle" title within 1.5s.
// Long-press was unreliable on iOS Safari (text selection magnifier still
// appears even with -webkit-touch-callout/user-select disabled). Quick
// successive taps don't trigger any native gesture, and the third tap
// fires confirm() inside an active user gesture.
(() => {
  const title = document.querySelector("header h1");
  if (!title) return;
  const WINDOW_MS = 1500;
  const REQUIRED = 3;
  let taps = [];

  title.addEventListener("click", () => {
    const now = Date.now();
    taps = taps.filter(t => now - t < WINDOW_MS);
    taps.push(now);
    if (taps.length < REQUIRED) return;
    taps = [];
    if (confirm("Reset today's puzzle? You'll get a fresh random one.")) {
      devReset();
    }
  });
  title.addEventListener("contextmenu", e => e.preventDefault());
})();

newPuzzle();
