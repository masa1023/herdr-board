// Reads and writes the per-session notes (goals, tasks, questions, next actions).
// Shared by the board and the herdr-board command. See `herdr-board raw` for the format.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DIR = process.env.HERDR_BOARD_DIR ?? join(homedir(), ".local/state/herdr-board");
export const pathFor = (id) => join(DIR, `${id}.md`);
export const donePathFor = (id) => join(DIR, `${id}.done.md`);

const SECTIONS = [
  ["tasks", "Tasks"],
  ["questions", "Questions"],
  ["next", "Next"],
];

export function parse(text) {
  const goals = [];
  let goal = null;
  let list = null;
  let item = null;
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^# (?:(active|on hold|done|dropped): )?(.+)/))) {
      goal = { state: m[1] ?? "active", name: m[2].trim(), notes: [], tasks: [], questions: [], next: [] };
      goals.push(goal);
      list = item = null;
    } else if (!goal) {
      continue;
    } else if ((m = line.match(/^## (.+)/))) {
      const key = SECTIONS.find(([, title]) => title === m[1].trim())?.[0];
      list = key ? goal[key] : null;
      item = null;
    } else if ((m = line.match(/^- (?:\[( |x|X)\] )?(.*)/))) {
      if (list) list.push((item = { done: m[1] !== undefined && m[1] !== " ", text: m[2], notes: [] }));
      else goal.notes.push(m[2]);
    } else if ((m = line.match(/^\s+- (.*)/)) && item) {
      item.notes.push(m[1]);
    }
  }
  return goals;
}

export function serialize(goals) {
  const out = [];
  for (const g of goals) {
    out.push(`# ${g.state}: ${g.name}`);
    for (const n of g.notes) out.push(`- ${n}`);
    for (const [key, title] of SECTIONS) {
      if (!g[key].length) continue;
      out.push(`## ${title}`);
      for (const it of g[key]) {
        out.push(key === "next" ? `- ${it.text}` : `- [${it.done ? "x" : " "}] ${it.text}`);
        for (const n of it.notes) out.push(`  - ${n}`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

export function load(id) {
  try {
    return parse(readFileSync(pathFor(id), "utf8"));
  } catch {
    return [];
  }
}

export function save(id, goals) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${pathFor(id)}.tmp`;
  writeFileSync(tmp, serialize(goals));
  renameSync(tmp, pathFor(id));
}

// Finished goals move to a separate file; the main file keeps only active and on-hold goals.
export function archive(id, goals, index, state, result) {
  const [g] = goals.splice(index, 1);
  g.state = state;
  g.notes.push(`${new Date().toISOString().slice(0, 10)} ${result}`);
  mkdirSync(DIR, { recursive: true });
  appendFileSync(donePathFor(id), serialize([g]) + "\n");
  save(id, goals);
}

export function loadDone(id) {
  try {
    return parse(readFileSync(donePathFor(id), "utf8"));
  } catch {
    return [];
  }
}

// Nobody reads the notes of a session that is gone, so delete them once they have been untouched for a while.
// Not immediately: a resumed session keeps writing under the same ID.
export function prune(liveIds, days = 30) {
  const limit = Date.now() - days * 86_400_000;
  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.replace(/(\.done)?\.md$/, "");
    if (id === name || liveIds.has(id)) continue;
    const path = join(DIR, name);
    try {
      if (statSync(path).mtimeMs < limit) unlinkSync(path);
    } catch {}
  }
}
