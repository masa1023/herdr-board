#!/usr/bin/env node
// Opens the board popup and passes the pane that was focused, so the board can select that session first.
import { execFileSync } from "node:child_process";

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const call = (...args) => JSON.parse(execFileSync(herdr, args, { encoding: "utf8" })).result;

const focused = call("pane", "list").panes.find((p) => p.focused);
const origin = focused ? ["--env", `BOARD_ORIGIN_PANE=${focused.pane_id}`, "--env", `BOARD_ORIGIN_TAB=${focused.tab_id}`] : [];
call("plugin", "pane", "open", "--plugin", "masa.board", "--entrypoint", "popup", ...origin);
