"use strict";

const TIME_LIMIT_MS = 60_000;
const WARN_AT_MS = 20_000;
const DANGER_AT_MS = 10_000;

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
  return { currentStreak: 0, maxStreak: 0, streakLastDay: null, gamesPlayed: 0, wins: 0 };
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
const timerEl         = document.getElementById("timer");
const startArea       = document.getElementById("startArea");
const startBtn        = document.getElementById("startBtn");
const lockedNotice    = document.getElementById("lockedNotice");
const lockedSummary   = document.getElementById("lockedSummary");
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
const endStats        = document.getElementById("endStats");
const lockedStats     = document.getElementById("lockedStats");
const newGameBtn      = document.getElementById("newGameBtn");
const opButtons       = Array.from(document.querySelectorAll(".op-btn"));

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
    lockedSummary.textContent = "You didn't submit a valid answer.";
  } else if (r && r.distance != null) {
    let off;
    if (r.distance === 0) {
      const secs = r.timeUsedMs ? Math.max(1, Math.round(r.timeUsedMs / 1000)) : null;
      off = secs != null ? `exact hit in ${secs}s 🎯` : "exact hit 🎯";
    } else {
      off = `off by ${r.distance}`;
    }
    lockedSummary.textContent = `Your answer: ${r.exprText} = ${r.result} (${off})`;
  } else {
    lockedSummary.textContent = "";
  }
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

  if (result === null) {
    state.result = { kind: "noanswer" };
    title = "Time's up";
    message = parseError
      ? `No valid answer (${parseError})`
      : "You didn't submit an expression.";
  } else {
    const distance = Math.abs(result - state.target);
    state.result = { exprText, result, distance, byTimeout, timeUsedMs };
    if (distance === 0) {
      const secs = Math.max(1, Math.round(timeUsedMs / 1000));
      const praise = byTimeout
        ? "Just in time"
        : secs <= 10 ? "Lightning fast"
        : secs <= 25 ? "Brilliant"
        : secs <= 45 ? "Nice one"
        : "You got there";
      title = `${praise}! 🎯`;
      message = `Solved in ${secs}s.\n${exprText} = ${result}`;
    } else if (distance <= 2) {
      title = byTimeout ? "Time's up — almost!" : "Almost!";
      message = `${exprText} = ${result} (off by ${distance})`;
    } else if (distance <= 5) {
      title = byTimeout ? "Time's up — so close!" : "So close!";
      message = `${exprText} = ${result} (off by ${distance})`;
    } else {
      title = byTimeout ? "Time's up" : "Submitted";
      message = `${exprText} = ${result} (off by ${distance}, target was ${state.target})`;
    }
  }
  endTitle.textContent = title;
  endMessage.textContent = message + "\n\nCome back tomorrow to play again.";
  endModal.hidden = false;

  // Update stats based on whether this run was an exact hit.
  const today = todayKey();
  const won = !!(state.result && state.result.distance === 0);
  const prev = state.stats || defaultStats();
  const newStats = {
    gamesPlayed: prev.gamesPlayed + 1,
    wins: prev.wins + (won ? 1 : 0),
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

function renderStats(container) {
  if (!container) return;
  const s = state.stats || defaultStats();
  const winPct = s.gamesPlayed ? Math.round((s.wins / s.gamesPlayed) * 100) : 0;
  container.innerHTML = "";
  const cells = [
    { num: s.currentStreak, lbl: "Streak", streak: true },
    { num: s.maxStreak,     lbl: "Best",   streak: true },
    { num: s.gamesPlayed,   lbl: "Played" },
    { num: `${winPct}%`,    lbl: "Win %"  },
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

// --- Rendering ---
function render() {
  targetEl.textContent = String(state.target);
  renderTiles();
  renderControls();
}

function renderTimer(ms) {
  const secs = Math.ceil(ms / 1000);
  timerEl.textContent = String(secs);
  timerEl.classList.toggle("danger", ms <= DANGER_AT_MS && state.phase === "running");
  timerEl.classList.toggle("warn", ms <= WARN_AT_MS && ms > DANGER_AT_MS && state.phase === "running");
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

// Tap-friendly reset: long-press the "Calcle" title (works on touch + mouse).
// Guarded by a confirm() so a stray hold doesn't wipe state.
(() => {
  const title = document.querySelector("header h1");
  if (!title) return;
  const HOLD_MS = 700;
  let pressTimer = null;
  let suppressClick = false;

  const start = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true;
      if (confirm("Reset today's puzzle? You'll get a fresh random one.")) {
        devReset();
      }
    }, HOLD_MS);
  };
  const cancel = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  title.addEventListener("touchstart", start, { passive: true });
  title.addEventListener("touchend", cancel);
  title.addEventListener("touchcancel", cancel);
  title.addEventListener("touchmove", cancel, { passive: true });
  title.addEventListener("mousedown", start);
  title.addEventListener("mouseup", cancel);
  title.addEventListener("mouseleave", cancel);
  title.addEventListener("contextmenu", e => {
    if (suppressClick) { e.preventDefault(); suppressClick = false; }
  });
})();

newPuzzle();
