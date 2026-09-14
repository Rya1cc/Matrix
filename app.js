const STORAGE_KEY = "matrix-line-v3";

const LEVELS = {
  1: { rows: 3, vars: 3, difficulty: "easy" },
  2: { rows: 3, vars: 3, difficulty: "medium" },
  3: { rows: 3, vars: 3, difficulty: "hard" },
  4: { rows: 4, vars: 4, difficulty: "easy" },
  5: { rows: 4, vars: 4, difficulty: "medium" },
  6: { rows: 4, vars: 4, difficulty: "hard" },
  7: { rows: 4, vars: 6, difficulty: "easy" },
  8: { rows: 4, vars: 5, difficulty: "medium" },
  9: { rows: 4, vars: 5, difficulty: "hard" },
  10: { rows: 6, vars: 6, difficulty: "easy" },
  11: { rows: 5, vars: 5, difficulty: "medium" },
  12: { rows: 5, vars: 6, difficulty: "hard" },
};

const el = (id) => document.getElementById(id);
const workspace = el("workspace");
const statusEl = el("status");

function uid() {
  return (crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
}

function levelLabel(level) {
  const x = LEVELS[level];
  return `Level ${level} · ${x.rows}×${x.vars} ${x.difficulty}`;
}

function stringMatrix(matrix) {
  return matrix.map(row => row.map(v => String(v)));
}

function defaultState() {
  return {
    level: 1,
    matrices: [{
      id: uid(),
      values: stringMatrix([
        [1, 1, 1, 6],
        [2, 1, -1, 1],
        [1, -1, 2, 5],
      ]),
      variables: 3,
    }],
    operations: [],
    answerEnabled: false,
    answer: "",
    checks: [],
    answerStatus: null,
    questionSource: "starter",
  };
}

let state = defaultState();
let apiState = { configured: false, model: null };
let toastTimer = null;

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (apiState.configured) {
    statusEl.textContent = `AI · ${apiState.model}`;
    statusEl.className = "status ai";
  } else {
    statusEl.textContent = "Saved locally";
    statusEl.className = "status";
  }
}

function queueSave() {
  statusEl.textContent = "Saving…";
  clearTimeout(queueSave.timer);
  queueSave.timer = setTimeout(saveLocal, 180);
}

function loadLocal() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.matrices) && parsed.matrices.length) {
      state = { ...defaultState(), ...parsed };
      state.matrices = state.matrices.map(m => ({ ...m, id: m.id || uid() }));
    }
  } catch (_) {}
}

function toast(message) {
  const t = el("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

function openModal(title, body) {
  el("modalTitle").textContent = title;
  el("modalBody").textContent = body;
  el("modalBackdrop").classList.remove("hidden");
}

function closeModal() {
  el("modalBackdrop").classList.add("hidden");
}

el("modalClose").addEventListener("click", closeModal);
el("modalBackdrop").addEventListener("click", (e) => {
  if (e.target === el("modalBackdrop")) closeModal();
});

// ---------- Exact rational arithmetic ----------
function bgcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

function rat(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  if (d === 0n) throw new Error("Denominator cannot be zero.");
  if (d < 0n) { n = -n; d = -d; }
  const g = bgcd(n, d);
  return { n: n / g, d: d / g };
}

const R0 = () => rat(0n);
const R1 = () => rat(1n);
const radd = (a,b) => rat(a.n*b.d + b.n*a.d, a.d*b.d);
const rneg = (a) => rat(-a.n, a.d);
const rsub = (a,b) => radd(a, rneg(b));
const rmul = (a,b) => rat(a.n*b.n, a.d*b.d);
const rdiv = (a,b) => { if (b.n === 0n) throw new Error("Division by zero."); return rat(a.n*b.d, a.d*b.n); };
const req = (a,b) => a.n === b.n && a.d === b.d;
const risZero = (a) => a.n === 0n;

function parseRat(raw) {
  let s = String(raw ?? "").trim().replace(/−/g, "-");
  if (!s) throw new Error("Blank matrix entry.");
  while (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  if (/^[+-]?\d+$/.test(s)) return rat(BigInt(s));
  if (/^[+-]?\d+\/[-+]?\d+$/.test(s)) {
    const [a,b] = s.split("/");
    return rat(BigInt(a), BigInt(b));
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)$/.test(s)) {
    const neg = s.startsWith("-");
    if (s[0] === "+" || s[0] === "-") s = s.slice(1);
    const [whole, frac = ""] = s.split(".");
    const scale = 10n ** BigInt(frac.length);
    const n = BigInt((whole || "0") + frac);
    return rat(neg ? -n : n, scale);
  }
  throw new Error(`Invalid number: ${raw}`);
}

function rstr(a) {
  return a.d === 1n ? String(a.n) : `${a.n}/${a.d}`;
}

function parseMatrix(values) {
  return values.map(row => row.map(parseRat));
}

function cloneRMatrix(m) {
  return m.map(row => row.map(v => rat(v.n, v.d)));
}

function rationalToStrings(m) {
  return m.map(row => row.map(rstr));
}

function matrixEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) if (!req(a[r][c], b[r][c])) return false;
  }
  return true;
}

function firstDifference(expected, actual) {
  const rows = Math.min(expected.length, actual.length);
  for (let r = 0; r < rows; r++) {
    const cols = Math.min(expected[r].length, actual[r].length);
    for (let c = 0; c < cols; c++) {
      if (!req(expected[r][c], actual[r][c])) return { r, c, expected: rstr(expected[r][c]), actual: rstr(actual[r][c]) };
    }
  }
  return null;
}

// ---------- Row operation parser ----------
function normalizeArrows(s) {
  return s.replace(/<-->/g, "↔").replace(/<->/g, "↔").replace(/-->/g, "→").replace(/->/g, "→");
}

function splitLinearTerms(expr) {
  const s = expr.replace(/\s+/g, "").replace(/\*/g, "").replace(/−/g, "-");
  if (!s) throw new Error("Missing row expression.");
  const terms = [];
  let depth = 0;
  let start = 0;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === "+" || ch === "-")) {
      terms.push(s.slice(start, i));
      start = i;
    }
  }
  terms.push(s.slice(start));
  return terms.filter(Boolean);
}

function parseRowExpression(expr, rowCount) {
  const terms = splitLinearTerms(expr);
  const parsed = [];
  for (let term of terms) {
    let sign = 1;
    if (term.startsWith("+")) term = term.slice(1);
    else if (term.startsWith("-")) { sign = -1; term = term.slice(1); }
    const match = term.match(/^(.*?)R(\d+)$/i);
    if (!match) throw new Error(`Could not read row term “${term}”.`);
    let coeffText = match[1] || "1";
    while (coeffText.startsWith("(") && coeffText.endsWith(")")) coeffText = coeffText.slice(1,-1);
    const rowIndex = Number(match[2]) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount) throw new Error(`R${match[2]} does not exist.`);
    let coeff = parseRat(coeffText);
    if (sign < 0) coeff = rneg(coeff);
    parsed.push({ coeff, rowIndex });
  }
  return parsed;
}

function applyOneOperation(matrix, rawLine) {
  let line = normalizeArrows(rawLine.trim());
  if (!line) return matrix;
  const swap = line.replace(/\s+/g, "").match(/^R(\d+)↔R(\d+)$/i);
  if (swap) {
    const a = Number(swap[1]) - 1, b = Number(swap[2]) - 1;
    if (a < 0 || b < 0 || a >= matrix.length || b >= matrix.length) throw new Error("Swap references a row that does not exist.");
    const next = cloneRMatrix(matrix);
    [next[a], next[b]] = [next[b], next[a]];
    return next;
  }

  const parts = line.split("→");
  if (parts.length !== 2) throw new Error(`Use an arrow, for example R2 + R1 → R2.`);
  const dest = parts[1].trim().match(/^R(\d+)$/i);
  if (!dest) throw new Error("The right side of the arrow must be one destination row, such as R2.");
  const destIndex = Number(dest[1]) - 1;
  if (destIndex < 0 || destIndex >= matrix.length) throw new Error(`R${dest[1]} does not exist.`);
  const terms = parseRowExpression(parts[0], matrix.length);
  const cols = matrix[0].length;
  const newRow = Array.from({ length: cols }, () => R0());
  for (const { coeff, rowIndex } of terms) {
    for (let c = 0; c < cols; c++) newRow[c] = radd(newRow[c], rmul(coeff, matrix[rowIndex][c]));
  }
  const next = cloneRMatrix(matrix);
  next[destIndex] = newRow;
  return next;
}

function applyOperations(values, opText) {
  let matrix = parseMatrix(values);
  const lines = String(opText || "").split(/\n|;/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) throw new Error("No row operation was entered for this step.");
  for (const line of lines) matrix = applyOneOperation(matrix, line);
  return matrix;
}

// ---------- RREF / solution ----------
function fmtCoeff(a) {
  if (req(a, R1())) return "";
  if (req(a, rat(-1))) return "-";
  const s = rstr(a);
  return s.includes("/") ? `(${s})` : s;
}

function rrefWithSteps(values) {
  const a = parseMatrix(values);
  const steps = [];
  const rows = a.length, cols = a[0].length;
  const varCols = cols - 1;
  let pivotRow = 0;

  for (let col = 0; col < varCols && pivotRow < rows; col++) {
    let pivot = pivotRow;
    while (pivot < rows && risZero(a[pivot][col])) pivot++;
    if (pivot === rows) continue;

    if (pivot !== pivotRow) {
      [a[pivot], a[pivotRow]] = [a[pivotRow], a[pivot]];
      steps.push({ op: `R${pivotRow+1} ↔ R${pivot+1}`, matrix: rationalToStrings(cloneRMatrix(a)) });
    }

    const p = a[pivotRow][col];
    if (!req(p, R1())) {
      const scale = rdiv(R1(), p);
      a[pivotRow] = a[pivotRow].map(v => rmul(scale, v));
      steps.push({ op: `${fmtCoeff(scale)}R${pivotRow+1} → R${pivotRow+1}`, matrix: rationalToStrings(cloneRMatrix(a)) });
    }

    for (let r = 0; r < rows; r++) {
      if (r === pivotRow || risZero(a[r][col])) continue;
      const f = a[r][col];
      a[r] = a[r].map((v,c) => rsub(v, rmul(f, a[pivotRow][c])));
      const abs = f.n < 0n ? rneg(f) : f;
      const sign = f.n < 0n ? "+" : "-";
      const coeff = req(abs, R1()) ? "" : fmtCoeff(abs);
      steps.push({ op: `R${r+1} ${sign} ${coeff}R${pivotRow+1} → R${r+1}`, matrix: rationalToStrings(cloneRMatrix(a)) });
    }
    pivotRow++;
  }
  return { rref: cloneRMatrix(a), steps };
}

function analyzeSolution(rref, variables) {
  let pivots = 0;
  const values = Array.from({ length: variables }, () => null);
  for (let r = 0; r < rref.length; r++) {
    let pivot = -1;
    for (let c = 0; c < variables; c++) {
      if (!risZero(rref[r][c])) { pivot = c; break; }
    }
    if (pivot === -1) {
      if (!risZero(rref[r][variables])) return { type: "none" };
      continue;
    }
    pivots++;
    let isPivotRow = req(rref[r][pivot], R1());
    for (let rr = 0; rr < rref.length; rr++) {
      if (rr !== r && !risZero(rref[rr][pivot])) isPivotRow = false;
    }
    if (isPivotRow) values[pivot] = rref[r][variables];
  }
  if (pivots < variables) return { type: "infinite" };
  return { type: "unique", values };
}

function varName(index, count) {
  if (count === 3) return ["x", "y", "z"][index];
  return `x${index + 1}`;
}

function solutionText(solution, variables) {
  if (solution.type === "none") return "No solution";
  if (solution.type === "infinite") return "Infinitely many solutions";
  return solution.values.map((v,i) => `${varName(i, variables)} = ${rstr(v)}`).join("\n");
}

function checkAnswerText(text, solution, variables) {
  const clean = String(text || "").trim().toLowerCase();
  if (solution.type === "none") return /no\s+solution|inconsistent/.test(clean);
  if (solution.type === "infinite") return /infinit(?:e|ely)|many\s+solutions|free\s+variable/.test(clean);

  const found = new Map();
  const patterns = [];
  for (let i = 0; i < variables; i++) {
    const name = varName(i, variables).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push({ i, re: new RegExp(`(?:^|[\\n,;\\s])${name}\\s*=\\s*([+-]?(?:\\d+(?:\\/[-+]?\\d+)?|\\d*\\.\\d+))`, "i") });
    patterns.push({ i, re: new RegExp(`(?:^|[\\n,;\\s])x${i+1}\\s*=\\s*([+-]?(?:\\d+(?:\\/[-+]?\\d+)?|\\d*\\.\\d+))`, "i") });
  }
  for (const p of patterns) {
    const m = String(text).match(p.re);
    if (m && !found.has(p.i)) {
      try { found.set(p.i, parseRat(m[1])); } catch (_) {}
    }
  }
  if (found.size !== variables) return false;
  for (let i = 0; i < variables; i++) if (!req(found.get(i), solution.values[i])) return false;
  return true;
}

// ---------- Local question fallback ----------
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateLocalQuestion(level) {
  const cfg = LEVELS[level];
  const m = cfg.rows, n = cfg.vars;
  const mag = cfg.difficulty === "easy" ? 2 : cfg.difficulty === "medium" ? 3 : 4;
  const x = Array.from({length:n}, () => randInt(-mag, mag));
  const A = Array.from({length:m}, (_,r) => Array.from({length:n}, (_,c) => c === r ? 1 : (c >= m ? randInt(-2,2) : 0)));
  const aug = A.map(row => [...row, row.reduce((sum,v,c) => sum + v*x[c], 0)]);

  const count = cfg.difficulty === "easy" ? m + 2 : cfg.difficulty === "medium" ? m + 5 : m + 8;
  for (let k = 0; k < count; k++) {
    const kind = randInt(0, 2);
    let r1 = randInt(0, m-1), r2 = randInt(0, m-1);
    while (r2 === r1) r2 = randInt(0, m-1);
    if (kind === 0) [aug[r1], aug[r2]] = [aug[r2], aug[r1]];
    else {
      let factor = randInt(-mag, mag);
      if (factor === 0) factor = 1;
      aug[r1] = aug[r1].map((v,c) => v + factor*aug[r2][c]);
    }
  }
  return aug;
}

// ---------- Rendering ----------
function clearChecks() {
  state.checks = [];
  state.answerStatus = null;
}

function matrixCard(matrix, index) {
  const question = index === 0;
  const check = index > 0 ? state.checks[index - 1] : null;
  const card = document.createElement("div");
  card.className = "matrix-card" + (question ? " question" : "");
  if (check?.status === "correct") card.classList.add("correct");
  if (check?.status === "wrong") card.classList.add("wrong");
  if (check?.status === "carried") card.classList.add("carried");

  const top = document.createElement("div");
  top.className = "matrix-top";
  const left = document.createElement("div");
  const label = document.createElement("div");
  label.className = "matrix-label";
  label.textContent = question ? "QUESTION · MATRIX 1" : `Matrix ${index + 1}`;
  const note = document.createElement("div");
  note.className = "matrix-note";
  note.textContent = question ? "locked" : "solution step";
  left.append(label, note);
  top.append(left);

  if (!question) {
    const del = document.createElement("button");
    del.className = "mini-btn danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      state.matrices.splice(index, 1);
      if (index - 1 < state.operations.length) state.operations.splice(index - 1, 1);
      while (state.operations.length > state.matrices.length - 1) state.operations.pop();
      clearChecks();
      render(); queueSave();
    });
    top.append(del);
  }

  const shell = document.createElement("div");
  shell.className = "matrix-shell";
  const lb = document.createElement("div"); lb.className = "bracket left";
  const rb = document.createElement("div"); rb.className = "bracket right";
  const grid = document.createElement("div");
  grid.className = "matrix-grid";
  const rows = matrix.values.length;
  const cols = matrix.values[0].length;
  grid.style.gridTemplateColumns = `repeat(${cols}, 56px)`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wrap = document.createElement("div");
      wrap.className = "matrix-cell-wrap" + (c === cols - 1 ? " aug" : "");
      wrap.dataset.cell = `${index}-${r}-${c}`;
      const value = String(matrix.values[r][c] ?? "");

      if (value.includes("/") && /^[-+]?[^/]*\/[^/]*$/.test(value)) {
        const [num, den] = value.split("/");
        const frac = document.createElement("div"); frac.className = "fraction-cell";
        const n = document.createElement("input"); n.className = "frac-part frac-num"; n.value = num; n.readOnly = question;
        const line = document.createElement("div"); line.className = "frac-line";
        const d = document.createElement("input"); d.className = "frac-part frac-den"; d.value = den; d.readOnly = question;
        if (!question) {
          const update = () => { matrix.values[r][c] = `${n.value}/${d.value}`; clearChecks(); queueSave(); };
          n.addEventListener("input", update); d.addEventListener("input", update);
        }
        frac.append(n, line, d); wrap.append(frac);
      } else {
        const input = document.createElement("input");
        input.className = "cell";
        input.value = value;
        input.readOnly = question;
        if (!question) {
          input.addEventListener("input", () => {
            matrix.values[r][c] = input.value;
            clearChecks();
            queueSave();
            if (input.value.includes("/")) {
              const cellKey = `${index}-${r}-${c}`;
              render();
              requestAnimationFrame(() => {
                const target = workspace.querySelector(`[data-cell="${cellKey}"] .frac-den`);
                if (target) { target.focus(); target.setSelectionRange(target.value.length, target.value.length); }
              });
            }
          });
        }
        wrap.append(input);
      }
      grid.append(wrap);
    }
  }

  shell.append(lb, grid, rb);
  card.append(top, shell);

  if (check?.status === "wrong" || check?.status === "carried") {
    const row = document.createElement("div"); row.className = "feedback-row";
    const btn = document.createElement("button");
    btn.className = `feedback-btn ${check.status === "wrong" ? "error" : "carried"}`;
    btn.textContent = check.status === "wrong" ? "Why is this wrong?" : "Earlier error carried here";
    btn.addEventListener("click", () => explainCheck(index - 1));
    row.append(btn); card.append(row);
  }
  return card;
}

function arrowBlock(index) {
  const wrap = document.createElement("div");
  wrap.className = "arrow-block";
  const input = document.createElement("textarea");
  input.className = "op-input";
  input.placeholder = "R3 - 2R1 --> R3\nR2 + R1 --> R2";
  input.value = state.operations[index] || "";
  input.spellcheck = false;
  input.addEventListener("input", () => {
    // Word-style auto replacement, preserving the caret. This also handles pasted text.
    const caret = input.selectionStart;
    const original = input.value;
    const converted = normalizeArrows(original);
    if (converted !== original) {
      const newCaret = normalizeArrows(original.slice(0, caret)).length;
      input.value = converted;
      input.setSelectionRange(newCaret, newCaret);
    }
    state.operations[index] = input.value;
    clearChecks(); queueSave();
  });
  const arrow = document.createElement("div"); arrow.className = "arrow";
  const help = document.createElement("div"); help.className = "arrow-help"; help.textContent = "top → bottom";
  wrap.append(input, arrow, help);
  return wrap;
}

function answerCard() {
  const card = document.createElement("div");
  card.className = "answer-card";
  if (state.answerStatus === "correct") card.classList.add("correct");
  if (state.answerStatus === "wrong") card.classList.add("wrong");
  const title = document.createElement("div"); title.className = "answer-title"; title.textContent = "ANSWER";
  const help = document.createElement("div"); help.className = "answer-help";
  const vars = state.matrices[0].variables || LEVELS[state.level].vars;
  help.textContent = vars === 3 ? "Use x = …, y = …, z = …; fractions are accepted." : "Use x1 = …, x2 = …, etc.; fractions are accepted.";
  const area = document.createElement("textarea"); area.className = "answer-input"; area.value = state.answer || "";
  area.placeholder = vars === 3 ? "x =\ny =\nz =" : "x1 =\nx2 =\n…";
  area.addEventListener("input", () => { state.answer = area.value; state.answerStatus = null; queueSave(); });
  const remove = document.createElement("button"); remove.className = "answer-remove"; remove.textContent = "Remove Answer Box";
  remove.addEventListener("click", () => { state.answerEnabled = false; state.answerStatus = null; render(); queueSave(); });
  card.append(title, help, area, remove);
  return card;
}

function render() {
  workspace.innerHTML = "";
  el("levelSelect").value = String(state.level);
  el("questionLabel").textContent = levelLabel(state.level);

  state.matrices.forEach((m, i) => {
    workspace.append(matrixCard(m, i));
    if (i < state.matrices.length - 1) workspace.append(arrowBlock(i));
  });

  if (state.answerEnabled) {
    const arr = document.createElement("div"); arr.className = "arrow-block";
    const final = document.createElement("div"); final.className = "arrow-help"; final.textContent = "final answer";
    const arrow = document.createElement("div"); arrow.className = "arrow";
    arr.append(final, arrow); workspace.append(arr, answerCard());
  }

  el("answerBtn").textContent = state.answerEnabled ? "Answer Box ✓" : "+ Answer Box";
}

// ---------- Checking ----------
function deterministicIssue(index, error, expected, actual) {
  if (error) return error.message || String(error);
  if (expected && actual) {
    const diff = firstDifference(expected, actual);
    if (diff) return `Row ${diff.r+1}, column ${diff.c+1} should be ${diff.expected}, but the matrix shows ${diff.actual}.`;
  }
  return "This matrix does not match the entered row operation.";
}

function checkWork() {
  const checks = [];
  let earlierError = false;
  let localErrors = 0;

  for (let i = 1; i < state.matrices.length; i++) {
    let expected = null, actual = null, error = null;
    try { expected = applyOperations(state.matrices[i-1].values, state.operations[i-1] || ""); }
    catch (e) { error = e; }
    try { actual = parseMatrix(state.matrices[i].values); }
    catch (e) { error = error || e; }

    const locallyCorrect = !error && matrixEqual(expected, actual);
    if (!locallyCorrect) {
      localErrors++;
      const issue = deterministicIssue(i, error, expected, actual);
      checks.push({
        status: "wrong",
        operation: state.operations[i-1] || "",
        issue,
        expected: expected ? rationalToStrings(expected) : null,
        actual: actual ? rationalToStrings(actual) : state.matrices[i].values,
        carried: false,
      });
      earlierError = true;
    } else if (earlierError) {
      checks.push({
        status: "carried",
        operation: state.operations[i-1] || "",
        issue: "This operation is valid on the previous matrix, but that previous matrix already contains an earlier error.",
        expected: rationalToStrings(expected),
        actual: rationalToStrings(actual),
        carried: true,
      });
    } else {
      checks.push({ status: "correct", operation: state.operations[i-1] || "" });
    }
  }
  state.checks = checks;

  let rrefResult, solution;
  try {
    rrefResult = rrefWithSteps(state.matrices[0].values);
    solution = analyzeSolution(rrefResult.rref, state.matrices[0].variables);
  } catch (e) {
    toast(`Question matrix error: ${e.message}`);
    render(); return;
  }

  if (state.answerEnabled) {
    state.answerStatus = checkAnswerText(state.answer, solution, state.matrices[0].variables) ? "correct" : "wrong";
  } else state.answerStatus = null;

  let finalRref = false;
  try { finalRref = matrixEqual(parseMatrix(state.matrices[state.matrices.length - 1].values), rrefResult.rref); } catch (_) {}

  if (localErrors) toast(`${localErrors} new row-operation mistake${localErrors === 1 ? "" : "s"} found.`);
  else if (state.matrices.length === 1) toast("Add a solution matrix to start showing your work.");
  else if (!finalRref) toast("All shown transformations are valid. Continue until the matrix is in RREF.");
  else if (state.answerEnabled && state.answerStatus === "wrong") toast("The row reduction is correct, but the answer box is not correct yet.");
  else if (state.answerEnabled) toast("Correct — row reduction and final answer both check out.");
  else toast("Correct row reduction. Add an Answer Box if you want to check the variable values too.");

  render(); queueSave();
}

async function explainCheck(checkIndex) {
  const check = state.checks[checkIndex];
  if (!check) return;
  const title = check.status === "carried" ? "Earlier mistake carried forward" : "Step feedback";
  openModal(title, check.issue);

  if (!apiState.configured || location.protocol === "file:") return;
  el("modalBody").innerHTML = `<span class="spinner"></span>Getting concise AI analysis…`;
  try {
    const res = await fetch("/api/explain-mistake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(check),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "AI request failed.");
    el("modalBody").textContent = data.explanation;
  } catch (e) {
    el("modalBody").textContent = `${check.issue}\n\nAI explanation unavailable: ${e.message}`;
  }
}

// ---------- Question generation ----------
function setQuestion(level, matrix, source) {
  const cfg = LEVELS[level];
  state = {
    level,
    matrices: [{ id: uid(), values: stringMatrix(matrix), variables: cfg.vars }],
    operations: [],
    answerEnabled: false,
    answer: "",
    checks: [],
    answerStatus: null,
    questionSource: source,
  };
  render(); saveLocal();
}

async function newQuestion() {
  const level = Number(el("levelSelect").value);
  const btn = el("newQuestionBtn");
  btn.disabled = true; btn.textContent = "Generating…";
  try {
    if (!apiState.configured || location.protocol === "file:") throw new Error("OpenAI API is not configured on the local server.");
    const res = await fetch("/api/generate-question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Question generation failed.");

    // Validate the model's question locally before accepting it.
    const cfg = LEVELS[level];
    const strings = stringMatrix(data.matrix);
    const solved = rrefWithSteps(strings);
    const analysis = analyzeSolution(solved.rref, cfg.vars);
    if (cfg.rows === cfg.vars && analysis.type !== "unique") throw new Error("AI generated a non-unique square system; using a local validated question instead.");
    setQuestion(level, data.matrix, "openai");
    toast(`New question generated with ${data.model}.`);
  } catch (e) {
    const local = generateLocalQuestion(level);
    setQuestion(level, local, "local-fallback");
    toast(`Used local generator: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = "New Question";
  }
}

// ---------- Toolbar ----------
el("newQuestionBtn").addEventListener("click", newQuestion);

el("levelSelect").addEventListener("change", () => {
  // Selection alone does not destroy current work. New Question applies it.
  el("questionLabel").textContent = levelLabel(Number(el("levelSelect").value));
});

el("addMatrixBtn").addEventListener("click", () => {
  const prev = state.matrices[state.matrices.length - 1];
  state.matrices.push({
    id: uid(),
    variables: state.matrices[0].variables,
    values: prev.values.map(row => [...row]),
  });
  while (state.operations.length < state.matrices.length - 1) state.operations.push("");
  clearChecks(); render(); queueSave();
  requestAnimationFrame(() => window.scrollTo({ left: document.body.scrollWidth, behavior: "smooth" }));
});

el("answerBtn").addEventListener("click", () => {
  state.answerEnabled = !state.answerEnabled;
  state.answerStatus = null;
  render(); queueSave();
});

el("checkBtn").addEventListener("click", checkWork);

el("solutionBtn").addEventListener("click", () => {
  try {
    const result = rrefWithSteps(state.matrices[0].values);
    const question = state.matrices[0];
    const matrices = [question];
    const operations = [];
    for (const step of result.steps) {
      operations.push(step.op);
      matrices.push({ id: uid(), variables: question.variables, values: step.matrix });
    }
    state.matrices = matrices;
    state.operations = operations;
    const sol = analyzeSolution(result.rref, question.variables);
    state.answerEnabled = true;
    state.answer = solutionText(sol, question.variables);
    state.checks = operations.map(op => ({ status: "correct", operation: op }));
    state.answerStatus = "correct";
    render(); queueSave();
    requestAnimationFrame(() => window.scrollTo({ left: document.body.scrollWidth, behavior: "smooth" }));
  } catch (e) { toast(`Could not solve: ${e.message}`); }
});

el("saveFileBtn").addEventListener("click", () => {
  const exportState = { ...state, checks: [], answerStatus: null };
  const blob = new Blob([JSON.stringify(exportState, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `matrix-line-level-${state.level}.matrixline`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

el("loadFileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.matrices) || !parsed.matrices.length) throw new Error("Invalid Matrix Line file.");
    state = { ...defaultState(), ...parsed, checks: [], answerStatus: null };
    state.matrices = state.matrices.map(m => ({ ...m, id: m.id || uid() }));
    render(); saveLocal(); toast("File loaded.");
  } catch (err) { toast(err.message); }
  e.target.value = "";
});

el("clearBtn").addEventListener("click", () => {
  if (!confirm("Clear your solution steps and answer, but keep the current question?")) return;
  state.matrices = [state.matrices[0]];
  state.operations = [];
  state.answerEnabled = false;
  state.answer = "";
  clearChecks(); render(); saveLocal();
});

async function detectApi() {
  if (location.protocol === "file:") {
    apiState = { configured: false, model: null };
    statusEl.textContent = "Local-only mode";
    statusEl.className = "status no-ai";
    return;
  }
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const data = await res.json();
    apiState = { configured: !!data.aiConfigured, model: data.model || null };
    if (apiState.configured) {
      statusEl.textContent = `AI · ${apiState.model}`;
      statusEl.className = "status ai";
    } else {
      statusEl.textContent = "Add key to .env";
      statusEl.className = "status no-ai";
    }
  } catch (_) {
    apiState = { configured: false, model: null };
    statusEl.textContent = "Local-only mode";
    statusEl.className = "status no-ai";
  }
}

loadLocal();
render();
detectApi();
saveLocal();
