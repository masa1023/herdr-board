#!/usr/bin/env node
// herdr-board: the command agents use to write the notes of their own session.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { archive, load, pathFor, save, serialize } from "./notes.mjs";

const USAGE = `herdr-board — write the goals, tasks and questions shown on the board

  herdr-board show                              print the current notes with their numbers
  herdr-board goal add "<goal>"                 add a goal
  herdr-board goal hold <g> "<reason>"          put it on hold
  herdr-board goal resume <g>                   make it active again
  herdr-board goal done <g> "<result>"          finished (moved to the archive file)
  herdr-board goal drop <g> "<reason>"          abandoned (moved to the archive file)
  herdr-board task add <g> "<task>"
  herdr-board task done <g> <n>
  herdr-board ask <g> "<question>" [--assume "<working assumption>"] [--blocks "<work that is waiting>"]
  herdr-board answer <g> <n> "<answer>"
  herdr-board next <g> "<label>" --prompt "<instruction>" [--reason "<why>"]
  herdr-board next clear <g>
  herdr-board path

<g> is the goal number and <n> the item number inside it (see show).
The session comes from CLAUDE_CODE_SESSION_ID or the herdr pane; --session <id> overrides it.`;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const fail = (msg) => {
  console.error(`herdr-board: ${msg}`);
  process.exit(1);
};

function sessionId() {
  const explicit = opt("session") ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (explicit) return explicit;
  const pane = process.env.HERDR_PANE_ID;
  if (pane) {
    try {
      const out = execFileSync(existsSync(process.env.HERDR_BIN_PATH ?? "") ? process.env.HERDR_BIN_PATH : "herdr", ["pane", "get", pane], { encoding: "utf8" });
      const id = JSON.parse(out).result.pane.agent_session?.value;
      if (id) return id;
    } catch {}
  }
  fail("cannot determine the session; pass --session <id>");
}

const id = sessionId();
const assume = opt("assume");
const blocks = opt("blocks");
const prompt = opt("prompt");
const reason = opt("reason");
const [cmd, ...rest] = args;
const goals = load(id);

const goalAt = (n) => goals[Number(n) - 1] ?? fail(`no goal ${n} (check the numbers with show)`);
const itemAt = (list, n, what) => list[Number(n) - 1] ?? fail(`no ${what} ${n} (check the numbers with show)`);
const need = (v, what) => v ?? fail(`missing ${what}\n\n${USAGE}`);

function show() {
  if (!goals.length) return console.log("(no goals)");
  goals.forEach((g, gi) => {
    console.log(`${gi + 1}. ${g.state}: ${g.name}`);
    for (const n of g.notes) console.log(`     ${n}`);
    g.tasks.forEach((t, i) => console.log(`   task ${i + 1} [${t.done ? "x" : " "}] ${t.text}`));
    g.questions.forEach((q, i) => {
      console.log(`   question ${i + 1} [${q.done ? "x" : " "}] ${q.text}`);
      for (const n of q.notes) console.log(`       ${n}`);
    });
    g.next.forEach((a, i) => console.log(`   next ${i + 1} ${a.text}`));
  });
}

switch (cmd) {
  case "show":
    show();
    process.exit(0);
  case "path":
    console.log(pathFor(id));
    process.exit(0);
  case "raw":
    process.stdout.write(serialize(goals));
    process.exit(0);
  case "goal": {
    const [sub, a, b] = rest;
    if (sub === "add") goals.push({ state: "active", name: need(a, "goal"), notes: [], tasks: [], questions: [], next: [] });
    else if (sub === "hold") Object.assign(goalAt(a), { state: "on hold" }).notes.push(`reason: ${need(b, "reason")}`);
    else if (sub === "resume") goalAt(a).state = "active";
    else if (sub === "done" || sub === "drop") {
      goalAt(a);
      const done = sub === "done";
      archive(id, goals, Number(a) - 1, done ? "done" : "dropped", `${done ? "result" : "reason"}: ${need(b, done ? "result" : "reason")}`);
      show();
      process.exit(0);
    } else fail(`unknown: goal ${sub ?? ""}\n\n${USAGE}`);
    break;
  }
  case "task": {
    const [sub, g, x] = rest;
    if (sub === "add") goalAt(g).tasks.push({ done: false, text: need(x, "task"), notes: [] });
    else if (sub === "done") itemAt(goalAt(g).tasks, x, "task").done = true;
    else fail(`unknown: task ${sub ?? ""}\n\n${USAGE}`);
    break;
  }
  case "ask": {
    const [g, text] = rest;
    const q = { done: false, text: need(text, "question"), notes: [] };
    if (assume) q.notes.push(`assuming: ${assume}`);
    if (blocks) q.notes.push(`blocks: ${blocks}`);
    goalAt(g).questions.push(q);
    break;
  }
  case "answer": {
    const [g, n, text] = rest;
    const q = itemAt(goalAt(g).questions, n, "question");
    q.done = true;
    q.notes.push(`answer: ${need(text, "answer")}`);
    break;
  }
  case "next": {
    if (rest[0] === "clear") goalAt(rest[1]).next = [];
    else {
      const [g, label] = rest;
      const a = { done: false, text: need(label, "label"), notes: [] };
      if (reason) a.notes.push(`reason: ${reason}`);
      a.notes.push(`prompt: ${need(prompt, "--prompt")}`);
      goalAt(g).next.push(a);
    }
    break;
  }
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
save(id, goals);
show();
