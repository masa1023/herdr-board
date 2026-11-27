#!/usr/bin/env node
// Lists every herdr agent, ordered: needs you → working → idle.
// Status, branch, PR and ports are collected automatically; goals, tasks, waiting work and questions come from the notes agents write with herdr-board.
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DIR, load, loadDone, prune, save } from "./notes.mjs";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const ONCE = process.argv.includes("--once");
// The pane that was focused when the popup opened (passed by open.mjs). Its session is selected first.
const ORIGIN = { pane: process.env.BOARD_ORIGIN_PANE, tab: process.env.BOARD_ORIGIN_TAB };

const TTL = { herdr: 2_000, git: 10_000, ports: 15_000, pr: 120_000 };
const SECTIONS = [
  { key: "attention", title: "Needs you", statuses: ["blocked", "done"] },
  { key: "working", title: "Working", statuses: ["working"] },
  { key: "idle", title: "Idle", statuses: ["idle"] },
];
const GLYPH = { blocked: "⚠", done: "✓", working: "●", idle: "○" };
const COLOR = { blocked: 33, done: 32, working: 36, idle: 90 };
// Nerd Font icons. They label each value in place of a column header row.
const ICON = { repo: "\uf401", branch: "\ue0a0", pr: "\uf407", ports: "\uf1e6", tasks: "\uf0ae", open: "?", goal: "\uf140" };

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 16 << 20, ...opts }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });

const herdrJson = async (...args) => {
  const out = await run(HERDR, args);
  try {
    return out ? JSON.parse(out).result : null;
  } catch {
    return null;
  }
};

// ---- state ----
const state = {
  agents: [],
  tabs: new Map(),
  workspaces: new Map(),
  git: new Map(), // cwd -> { at, top, branch }
  pr: new Map(), // `${top}\0${branch}` -> { at, pr }
  ports: { at: 0, list: [] }, // [{ port, cwd, cmd }]
  since: new Map(), // pane_id -> { seq, at }
  selected: 0,
  showIdle: true,
  expanded: null,
  showDone: false,
  flash: null,
  error: null,
  query: "",
  searching: false,
};

let pruned = false;
async function refreshHerdr() {
  const [agents, tabs, workspaces] = await Promise.all([
    herdrJson("agent", "list"),
    herdrJson("tab", "list"),
    herdrJson("workspace", "list"),
  ]);
  if (!agents) {
    state.error = "Cannot reach herdr";
    return;
  }
  state.error = null;
  state.agents = agents.agents;
  if (!pruned) {
    pruned = true;
    prune(new Set(state.agents.map((a) => a.agent_session?.value).filter(Boolean)));
  }
  if (tabs) state.tabs = new Map(tabs.tabs.map((t) => [t.tab_id, t]));
  if (workspaces) state.workspaces = new Map(workspaces.workspaces.map((w) => [w.workspace_id, w]));
  const now = Date.now();
  for (const a of state.agents) {
    const prev = state.since.get(a.pane_id);
    if (!prev) state.since.set(a.pane_id, { status: a.agent_status, at: null });
    else if (prev.status !== a.agent_status) state.since.set(a.pane_id, { status: a.agent_status, at: now });
  }
}

async function refreshGit(cwd) {
  const cached = state.git.get(cwd);
  if (cached && Date.now() - cached.at < TTL.git) return;
  state.git.set(cwd, { ...(cached ?? {}), at: Date.now() });
  const [top, status] = await Promise.all([
    run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
    run("git", ["-C", cwd, "status", "--porcelain=v2", "--branch"]),
  ]);
  if (!top || !status) {
    state.git.set(cwd, { at: Date.now(), top: null });
    return;
  }
  const info = { at: Date.now(), top: top.trim(), branch: null };
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
  }
  state.git.set(cwd, info);
}

async function refreshPr(top, branch) {
  if (!branch || branch === "(detached)" || ["main", "master", "develop"].includes(branch)) return;
  const key = `${top}\0${branch}`;
  const cached = state.pr.get(key);
  if (cached && Date.now() - cached.at < TTL.pr) return;
  state.pr.set(key, { ...(cached ?? {}), at: Date.now() });
  const out = await run(
    "gh",
    ["pr", "view", branch, "--json", "number,state,isDraft,reviewDecision,statusCheckRollup"],
    { cwd: top },
  );
  let pr = null;
  try {
    if (out) pr = JSON.parse(out);
  } catch {}
  state.pr.set(key, { at: Date.now(), pr });
}

async function refreshPorts() {
  if (Date.now() - state.ports.at < TTL.ports) return;
  state.ports.at = Date.now();
  const listen = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  if (!listen) return;
  const procs = new Map(); // pid -> { cmd, ports:Set }
  let cur = null;
  for (const line of listen.split("\n")) {
    if (line[0] === "p") procs.set(line.slice(1), (cur = { cmd: "", ports: new Set() }));
    else if (line[0] === "c" && cur) {
      cur.cmd = line.slice(1);
      // Claude Code itself (its process name is a version number) listens on internal ports; those are not dev servers.
      if (/^\d+\.\d+\.\d+$/.test(cur.cmd)) procs.delete([...procs.keys()].pop());
    }
    else if (line[0] === "n" && cur) {
      const port = line.slice(line.lastIndexOf(":") + 1);
      if (/^\d+$/.test(port)) cur.ports.add(Number(port));
    }
  }
  const list = [];
  // Ports of docker compose containers belong to com.docker.backend, so map them through the compose working directory.
  const docker = await run("docker", ["ps", "--format", '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}'], { timeout: 5_000 });
  for (const line of (docker ?? "").split("\n")) {
    const [dir, published] = line.split("\t");
    if (!dir || !published) continue;
    for (const m of published.matchAll(/:(\d+)->/g)) list.push({ port: Number(m[1]), cwd: dir, cmd: "docker" });
  }
  if (!procs.size) return void (state.ports.list = list);
  const cwds = await run("lsof", ["-a", "-d", "cwd", "-p", [...procs.keys()].join(","), "-Fpn"]);
  let pid = null;
  for (const line of (cwds ?? "").split("\n")) {
    if (line[0] === "p") pid = line.slice(1);
    else if (line[0] === "n" && procs.has(pid)) {
      const p = procs.get(pid);
      for (const port of p.ports) list.push({ port, cwd: line.slice(1), cmd: p.cmd });
    }
  }
  state.ports.list = list;
}

async function refreshAll() {
  await refreshHerdr();
  // git and port lookups can take seconds; draw what we already have first.
  if (!ONCE && started) render();
  const cwds = [...new Set(state.agents.map((a) => a.cwd).filter(Boolean))];
  await Promise.all([refreshPorts(), ...cwds.map(refreshGit)]);
  const prJobs = new Map();
  for (const cwd of cwds) {
    const g = state.git.get(cwd);
    if (g?.top) prJobs.set(`${g.top}\0${g.branch}`, [g.top, g.branch]);
  }
  const jobs = Promise.all([...prJobs.values()].map(([top, branch]) => refreshPr(top, branch)));
  if (ONCE) await jobs;
}

// ---- rendering ----
const isWide = (cp) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff);
const width = (s) => [...s].reduce((n, ch) => n + (isWide(ch.codePointAt(0)) ? 2 : 1), 0);
const fit = (s, w) => {
  if (w <= 0) return "";
  if (width(s) <= w) return s + " ".repeat(w - width(s));
  let out = "";
  let n = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (n + cw > w - 1) break;
    out += ch;
    n += cw;
  }
  return out + "…" + " ".repeat(w - n - 1);
};
const paint = (s, code) => (ONCE && !process.stdout.isTTY ? s : `\x1b[${code}m${s}\x1b[0m`);

const ago = (at) => {
  if (!at) return "";
  const m = Math.floor((Date.now() - at) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
};

function prLabel(top, branch) {
  const pr = state.pr.get(`${top}\0${branch}`)?.pr;
  if (!pr) return "";
  const checks = pr.statusCheckRollup ?? [];
  const failed = checks.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(c.conclusion ?? c.state));
  const pending = checks.some((c) => !(c.conclusion ?? "") && c.status !== "COMPLETED" && c.state !== "SUCCESS");
  const ci = !checks.length ? "" : failed ? " ✗CI" : pending ? " …CI" : " ✓CI";
  const kind = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const review = pr.reviewDecision === "APPROVED" ? " ✓approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? " ✗changes" : "";
  return `#${pr.number} ${kind}${ci}${review}`;
}

const sid = (a) => a.agent_session?.value ?? null;

function rows() {
  const home = homedir();
  return state.agents.map((a) => {
    const g = state.git.get(a.cwd) ?? {};
    const top = g.top ?? a.cwd ?? "";
    const ports = [...new Set(state.ports.list.filter((p) => p.cwd === top || p.cwd.startsWith(top + "/")).map((p) => p.port))].sort((x, y) => x - y);
    const ws = state.workspaces.get(a.workspace_id)?.label ?? a.workspace_id;
    const tab = state.tabs.get(a.tab_id)?.label ?? "";
    const goals = sid(a) ? load(sid(a)) : [];
    const running = goals.filter((x) => x.state === "active");
    const tasks = goals.flatMap((x) => x.tasks);
    const open = goals.flatMap((x) => x.questions.filter((q) => !q.done).map((q) => ({ goal: x, item: q })));
    const title = a.terminal_title_stripped ?? "";
    return {
      agent: a,
      status: a.agent_status,
      goals,
      open,
      where: tab ? `${ws}/${tab}` : ws,
      repo: g.top ? g.top.split("/").pop() : (a.cwd ?? "").replace(home, "~"),
      branch: g.branch ?? "",
      pr: g.top ? prLabel(g.top, g.branch) : "",
      ports: ports.map((p) => `:${p}`).join(" "),
      tasks: tasks.length ? `${tasks.filter((t) => t.done).length}/${tasks.length}` : "",
      questions: open.length ? String(open.length) : "",
      // Show the goal when there is one; otherwise fall back to the terminal title.
      summary: running.length ? `${goals.length > 1 ? `[${goals.length}] ` : ""}${running.at(-1).name}` : goals.length ? `(on hold) ${goals.at(-1).name}` : title,
      haystack: [ws, tab, a.cwd, g.branch, title, ...goals.flatMap((x) => [x.name, ...[...x.tasks, ...x.questions, ...x.waiting].map((i) => i.text)])]
        .filter(Boolean)
        .join("\n")
        .toLowerCase(),
    };
  });
}

// Every space-separated word of the query must appear somewhere in the session.
const matches = (r) => state.query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => r.haystack.includes(w));

function build() {
  const all = rows().filter(matches);
  const cols = process.stdout.columns ?? 120;
  const lines = [];
  const selectable = [];
  // Shrink columns in narrow panes and clip the rest (wrapping would break the row layout).
  const W = cols >= 150
    ? { where: 18, repo: 22, branch: 28, pr: 24, ports: 18, tasks: 8, open: 4 }
    : cols >= 110
      ? { where: 16, repo: 16, branch: 22, pr: 18, ports: 13, tasks: 8, open: 4 }
      : { where: 14, repo: 12, branch: 16, pr: 12, ports: 8, tasks: 8, open: 4 };
  const fixed = 2 + Object.values(W).reduce((a, b) => a + b + 1, 0);
  const titleW = Math.max(8, cols - fixed - 1);
  const clip = (line) => fit(line, cols - 1).trimEnd();
  // No icon for an empty cell.
  const cell = (key, text, w) => fit(text ? `${ICON[key]} ${text}` : "", w);
  const push = (entry, line, color) => {
    const idx = selectable.push(entry) - 1;
    lines.push(!ONCE && idx === state.selected ? `\x1b[7m${clip(line)}\x1b[0m` : paint(clip(line), color));
    return idx;
  };
  const sub = (line) => lines.push(paint(clip(line), 90));

  lines.push(paint(clip(` board  ${all.length} sessions  │ / search │ j/k select │ Space expand │ Enter go/type │ x done │ d finished goals │ i idle │ r refresh │ q quit`), 1));
  if (state.searching || state.query) {
    lines.push(paint(clip(` / ${state.query}${state.searching ? "▏" : ""}   ${all.length} match${all.length === 1 ? "" : "es"} │ ↑/↓ select │ Enter go │ Esc clear`), "1;35"));
  }
  if (state.error) lines.push(paint(` ${state.error}`, 31));
  if (state.flash) lines.push(paint(clip(` ${state.flash}`), 32));

  const needsMe = (r) => r.open.length > 0 || SECTIONS[0].statuses.includes(r.status);
  for (const sec of SECTIONS) {
    const items = sec.key === "attention" ? all.filter(needsMe) : all.filter((r) => !needsMe(r) && sec.statuses.includes(r.status));
    const collapsed = sec.key === "idle" && !state.showIdle && !state.query;
    const openCount = items.reduce((n, r) => n + r.open.length, 0);
    lines.push("");
    lines.push(paint(`${sec.title} (${items.length})${openCount ? `  ${openCount} open question${openCount > 1 ? "s" : ""}` : ""}${collapsed ? "  — press i to show" : ""}`, sec.key === "attention" && items.length ? "1;33" : 1));
    if (collapsed) continue;
    for (const r of items) {
      const text = [fit(r.where, W.where), cell("repo", r.repo, W.repo), cell("branch", r.branch, W.branch), cell("pr", r.pr, W.pr), cell("ports", r.ports, W.ports), cell("tasks", r.tasks, W.tasks), cell("open", r.questions, W.open), cell("goal", r.summary, titleW)].join(" ");
      push({ row: r }, `${GLYPH[r.status] ?? "?"} ${text}`, COLOR[r.status] ?? 0);
      const expanded = ONCE || state.expanded === r.agent.pane_id;
      // Collapsed sessions take one line; open questions show only as a count.
      if (!expanded) continue;
      // One frame per goal, split into Questions, Tasks and Waiting.
      r.goals.forEach((g, gi) => {
        const held = g.state === "on hold";
        const open = g.questions.filter((x) => !x.done);
        lines.push(paint(clip(`  ┏ Goal ${gi + 1}  ${g.state}  ${g.name}`), held ? 90 : "1;36"));
        for (const n of g.notes) sub(`  ┃   ${n}`);
        if (open.length) {
          lines.push(paint(clip(`  ┃ Questions ${open.length}`), "1;33"));
          for (const q of open) {
            push({ row: r, kind: "question", item: q }, `  ┃   ? ${q.text}`, 33);
            for (const n of q.notes) sub(`  ┃       ${n}`);
          }
        }
        if (g.tasks.length) {
          lines.push(paint(clip(`  ┃ Tasks ${g.tasks.filter((t) => t.done).length}/${g.tasks.length}`), 1));
          for (const t of g.tasks) push({ row: r, kind: "task", item: t }, `  ┃   ${t.done ? "☑" : "☐"} ${t.text}`, t.done ? 90 : 0);
        }
        const waiting = g.waiting.filter((x) => !x.done);
        if (waiting.length) {
          lines.push(paint(clip(`  ┃ Waiting ${waiting.length}`), 35));
          for (const b of waiting) {
            push({ row: r, kind: "waiting", item: b }, `  ┃   ◷ ${b.text}`, 35);
            for (const n of b.notes) sub(`  ┃       ${n}`);
          }
        }
        lines.push(paint("  ┗", held ? 90 : 36));
      });
      if (state.showDone && sid(r.agent)) {
        const done = loadDone(sid(r.agent)).slice(-5);
        for (const g of done) sub(`  ▹ ${g.state}: ${g.name}${g.notes.length ? `  — ${g.notes.at(-1)}` : ""}`);
        if (!done.length) sub("  ▹ no finished goals yet");
      }
    }
  }
  return { lines, selectable };
}

let started = false;
let current = [];
const keyOf = (e) => (e ? `${e.row.agent.pane_id}\0${e.kind ?? ""}\0${e.item?.text ?? ""}` : null);
function render() {
  let { lines, selectable } = build();
  // Follow the selected item when rows reorder on refresh (an index alone would end up on another session).
  if (state.selKey) {
    const at = selectable.findIndex((e) => keyOf(e) === state.selKey);
    if (at >= 0 && at !== state.selected) {
      state.selected = at;
      ({ lines, selectable } = build());
    }
  }
  current = selectable;
  if (state.selected >= selectable.length) state.selected = Math.max(0, selectable.length - 1);
  state.selKey = keyOf(selectable[state.selected]);
  // Scroll so the selected row stays on screen.
  const rowsMax = process.stdout.rows ?? 40;
  const selLine = lines.findIndex((l) => l.startsWith("\x1b[7m"));
  const offset = selLine >= rowsMax ? selLine - rowsMax + 2 : 0;
  process.stdout.write("\x1b[H" + lines.slice(offset, offset + rowsMax).map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
}

const LIST = { task: "tasks", waiting: "waiting", question: "questions" };

// Toggle done/undone. Re-read the file before writing because the agent may be writing at the same time.
function toggle(entry) {
  const id = sid(entry.row.agent);
  const key = LIST[entry.kind];
  if (!id || !key) return;
  const goals = load(id);
  const item = goals.flatMap((g) => g[key]).find((x) => x.text === entry.item.text);
  if (!item) return;
  item.done = !item.done;
  save(id, goals);
}

// Capture stderr too so the reason for a failure can be shown.
const herdrDo = (...args) =>
  new Promise((resolve) => {
    execFile(HERDR, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const error = err ? (stderr || stdout || err.message).trim().split("\n").pop() : null;
      try {
        appendFileSync(join(DIR, "board.log"), `${new Date().toISOString()} ${args.slice(0, 3).join(" ")} ${error ?? "ok"}\n`);
      } catch {}
      resolve(error);
    });
  });

// Type a question, task or waiting item into the agent's prompt without submitting it, so the user can finish the message.
async function activate(target) {
  state.flash = null;
  const pane = target.row.agent.pane_id;
  // Typing into an agent that is blocked on a dialog would pick one of its options.
  if (LIST[target.kind] && target.row.status !== "blocked") {
    const label = { task: "Task", waiting: "Waiting", question: "Question" }[target.kind];
    const error = await herdrDo("pane", "send-text", pane, `${label} "${target.item.text}": `);
    if (error) return void (state.flash = `✗ Typing failed: ${error}`);
  }
  const error = await herdrDo("agent", "focus", pane);
  if (error) state.flash = `✗ Focus failed: ${error}`;
}

// ---- startup ----
if (ONCE) {
  await refreshAll();
  console.log(build().lines.join("\n"));
  process.exit(0);
}

const restore = () => process.stdout.write("\x1b[?25h\x1b[?1049l");
const quit = () => {
  restore();
  process.exit(0);
};
process.stdout.write("\x1b[?1049h\x1b[?25l");
started = true;
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
process.stdout.on("resize", render);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", async (buf) => {
    const k = buf.toString();
    if (k === "\x03") return quit();
    // Esc clears the search first and closes the popup only when there is none.
    if (k === "\x1b" && (state.searching || state.query)) {
      state.query = "";
      state.searching = false;
      state.selected = 0;
      state.selKey = null;
      return render();
    }
    // While typing a query, letters go into it; arrows and Enter still move and go.
    if (state.searching && !k.startsWith("\x1b") && k !== "\r" && k !== "\n") {
      if (k === "\x7f" || k === "\b") state.query = Array.from(state.query).slice(0, -1).join("");
      else if (k === "\x15") state.query = "";
      else state.query += k.replace(/[\x00-\x1f\x7f]/g, "");
      state.selected = 0;
      state.selKey = null;
      return render();
    }
    if (k === "/") {
      state.searching = true;
      return render();
    }
    if (k === "q" || k === "\x1b") return quit();
    const nav = k === "j" || k === "\x1b[B" ? 1 : k === "k" || k === "\x1b[A" ? -1 : 0;
    const enter = k === "\r" || k === "\n";
    if (nav) {
      state.selected = Math.max(0, Math.min(current.length - 1, state.selected + nav));
      state.selKey = null;
    }
    else if (k === "i") state.showIdle = !state.showIdle;
    else if (k === " ") {
      const target = current[state.selected];
      if (target) {
        // Only one session is expanded at a time. Rows shift when toggling, so keep the selection on that session's row.
        const id = target.row.agent.pane_id;
        state.expanded = state.expanded === id ? null : id;
        state.selected = Math.max(0, build().selectable.findIndex((e) => e.row.agent.pane_id === id && !e.kind));
        state.selKey = null;
      }
    }
    else if (k === "r") {
      state.ports.at = 0;
      state.git.clear();
      state.pr.clear();
      await refreshAll();
    } else if (enter) {
      const target = current[state.selected];
      if (target) {
        await activate(target);
        // Close the popup after moving. Keep it open on failure so the reason stays readable.
        if (!state.flash?.startsWith("✗")) return quit();
      }
    } else if (k === "x") {
      const target = current[state.selected];
      if (target) toggle(target);
    } else if (k === "d") state.showDone = !state.showDone;
    if (!enter) state.flash = null;
    render();
  });
}

let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try {
    await refreshAll();
  } finally {
    busy = false;
  }
  render();
};
await refreshHerdr();
// If the focused pane was not an agent, pick an agent in the same tab.
const origin = state.agents.find((a) => a.pane_id === ORIGIN.pane) ?? state.agents.find((a) => a.tab_id === ORIGIN.tab);
if (origin) {
  state.selKey = `${origin.pane_id}\0\0`;
  state.expanded = origin.pane_id;
}
await tick();
setInterval(tick, TTL.herdr);
