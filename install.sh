#!/bin/sh
# Sets up Clockwork on this machine: checks what it needs, installs its own dependencies into its data folder, and creates
# the config. It installs nothing system-wide and never asks for a password. Safe to run again.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${CLOCKWORK_DATA:-$HOME/.clockwork/v2}
say() { printf '%s\n' "$*"; }
fail() { printf 'Stopped: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node 24 or newer is needed (https://nodejs.org or: brew install node)"
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 24')" = true ] || fail "Node 24 or newer is needed; this is $(node --version)"

PY=${CLOCKWORK_PYTHON:-}
if [ -z "$PY" ]; then for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then PY=$c; break; fi; done; fi
[ -n "$PY" ] || fail "Python 3.10 to 3.13 is needed for the local model (brew install python@3.12)"

mkdir -p "$DATA" && chmod 700 "$DATA"
say "1/4 core dependencies"
(cd "$HERE/core" && npm ci --omit=dev --no-audit --no-fund >/dev/null)

say "2/4 local model environment in $DATA/venv (the first time this downloads about 1 GB of libraries)"
# The lock file pins the Linux CPU build of torch; elsewhere the same version comes from the normal index.
REQ=$(mktemp); trap 'rm -f "$REQ"' EXIT
if [ "$(uname -s)" = Linux ]; then cp "$HERE/student/requirements.lock" "$REQ"; EXTRA="--extra-index-url https://download.pytorch.org/whl/cpu"
else sed 's/+cpu$//' "$HERE/student/requirements.lock" > "$REQ"; EXTRA=""; fi
if command -v uv >/dev/null 2>&1 && [ -z "$EXTRA" ]; then
  # uv needs no pip inside the environment, which also sidesteps Homebrew Pythons whose bundled pip cannot start.
  [ -x "$DATA/venv/bin/python" ] || uv venv --quiet --python "$PY" "$DATA/venv"
  uv pip install --quiet --python "$DATA/venv/bin/python" -r "$REQ"
else
  [ -x "$DATA/venv/bin/python" ] || "$PY" -m venv "$DATA/venv" || { rm -rf "$DATA/venv"
    fail "this Python could not create an environment (a known problem with some Homebrew Pythons on older macOS). Install uv (brew install uv) and run this again, or set CLOCKWORK_PYTHON to another Python 3.10 to 3.13."; }
  "$DATA/venv/bin/python" -m pip install --quiet --disable-pip-version-check -r "$REQ" $EXTRA
fi
"$DATA/venv/bin/python" -c 'import sentence_transformers, sklearn, joblib' 2>/dev/null || fail "the model libraries did not install correctly"

say "3/4 the clockwork command"
BIN=${CLOCKWORK_BIN:-$HOME/.local/bin}; mkdir -p "$BIN"; ln -sf "$HERE/bin/clockwork" "$BIN/clockwork"
case ":$PATH:" in *":$BIN:"*) ;; *) say "    $BIN is not on your PATH. Add it, or call $BIN/clockwork directly." ;; esac

say "4/4 config"
CLOCKWORK_DATA="$DATA" "$HERE/bin/clockwork" init
say ""
say "Installed. The local model itself (about 470 MB) is downloaded the first time Clockwork starts."
command -v go >/dev/null 2>&1 || say "WhatsApp needs Go to build its reader once: brew install go"
