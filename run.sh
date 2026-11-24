#!/bin/sh
# A herdr server started over SSH (remote mode) has a minimal PATH, so node, gh and docker
# installed through mise or Homebrew are not found. Add the usual locations before starting node.
PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
# After herdr is reinstalled elsewhere, a running server keeps handing out a HERDR_BIN_PATH that no longer exists.
if [ -n "${HERDR_BIN_PATH:-}" ] && [ ! -x "$HERDR_BIN_PATH" ]; then
  unset HERDR_BIN_PATH
fi
exec node "$@"
