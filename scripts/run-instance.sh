#!/bin/bash
# Supervises every process of one Clockwork instance.
# The core is the only required process: if it dies the container exits and the platform restarts it.
# Everything else is restarted in place, with pauses long enough not to hammer outside services.
set -u
: "${CLOCKWORK_TOKEN:?CLOCKWORK_TOKEN must be set: the core listens on all interfaces inside the container}"

keep() { # keep <name> <seconds between restarts> <command...>
  local name=$1 pause=$2; shift 2
  while true; do "$@"; echo "[$name] exited with $?; restarting in ${pause}s"; sleep "$pause"; done
}

# Connectors get the write-only ingest token. Only the core holds the Anthropic key and the admin and agent tokens.
# An account key from the host's secret store (the Gmail app password) is taken out of every process but the one that uses it.
connector() { env -u ANTHROPIC_API_KEY -u CLOCKWORK_AGENT_TOKEN -u CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD -u CLOCKWORK_SECRET_GITHUB_REPO_TOKEN "$@"; }
plain() { env -u ANTHROPIC_API_KEY -u CLOCKWORK_AGENT_TOKEN -u CLOCKWORK_TOKEN -u CLOCKWORK_INGEST_TOKEN -u CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD -u CLOCKWORK_SECRET_GITHUB_REPO_TOKEN "$@"; }

(cd /app/core && exec env -u CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD -u CLOCKWORK_SECRET_GITHUB_REPO_TOKEN node server.mjs) & core=$!
# MALLOC_ARENA_MAX: each request runs on its own thread, and by default the C library keeps a separate heap per thread, so the
# memory of finished embedding batches piled up (1.5 GB during a bulk import). Two heaps keep it flat.
keep student 30 plain env MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=262144 MALLOC_TRIM_THRESHOLD_=1048576 OMP_NUM_THREADS=2 bash -c 'cd /app/student && exec python serve.py' &
keep whatsapp 120 connector clockwork-whatsapp &
# A second WhatsApp account, when switched on: its own session folder and its own link page (reach it with `fly proxy 4598`).
keep whatsapp-2 120 connector bash -c '[ "${CLOCKWORK_WA_SECOND:-}" = 1 ] && exec env CLOCKWORK_WA_DATA=/data/whatsapp-2 CLOCKWORK_WA_LISTEN=[::]:4598 CLOCKWORK_WA_ACCOUNT="${CLOCKWORK_WA_SECOND_NAME:-second}" clockwork-whatsapp || sleep 3600' &
# Gmail only runs once it has been authorized (client.json and token.json present in /data/gmail).
keep gmail 60 connector env -u CLOCKWORK_TOKEN bash -c '[ -s /data/gmail/token.json ] && cd /app/connectors/gmail && exec node main.mjs || sleep 240' &
# Gmail with an app password: only when the host's secret store holds one (CLOCKWORK_SECRET_GMAIL_IMAP_ADDRESS and
# CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD). The password is never written to the volume. Use this or `gmail` above, not both.
keep gmail-imap 60 env -u ANTHROPIC_API_KEY -u CLOCKWORK_AGENT_TOKEN -u CLOCKWORK_TOKEN bash -c '[ -n "${CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD:-}" ] && cd /app/extractors/gmail-imap && exec env CLOCKWORK_EXTRACTOR_DATA=/data/gmail-imap CLOCKWORK_SECRET_ADDRESS="${CLOCKWORK_SECRET_GMAIL_IMAP_ADDRESS:-}" CLOCKWORK_SECRET_APP_PASSWORD="$CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD" node main.mjs || sleep 3600' &
# X capture from a browser on this machine: only when switched on (CLOCKWORK_X_CLOUD=1). See connectors/x-cloud/main.mjs.
keep x-cloud 300 connector env -u CLOCKWORK_TOKEN bash -c '[ "${CLOCKWORK_X_CLOUD:-}" = 1 ] && cd /app/connectors/x-cloud && exec node main.mjs || sleep 3600' &
# Activity of the GitHub repositories named in CLOCKWORK_GITHUB_REPOS (owner/name, separated by commas). A private one also needs
# CLOCKWORK_SECRET_GITHUB_REPO_TOKEN in the host's secret store: a read-only token for that repository, never written to the volume.
# See extractors/github-repo/README.md.
keep github-repo 60 env -u ANTHROPIC_API_KEY -u CLOCKWORK_AGENT_TOKEN -u CLOCKWORK_TOKEN -u CLOCKWORK_SECRET_GMAIL_IMAP_APP_PASSWORD bash -c '[ -n "${CLOCKWORK_GITHUB_REPOS:-}" ] && mkdir -p /data/github-repo && cd /app/extractors/github-repo && exec env -u CLOCKWORK_SECRET_GITHUB_REPO_TOKEN CLOCKWORK_EXTRACTOR_DATA=/data/github-repo CLOCKWORK_SECRET_TOKEN="${CLOCKWORK_SECRET_GITHUB_REPO_TOKEN:-}" node main.mjs || sleep 3600' &
# Daily retrain, first run ten minutes after boot so it never competes with start-up for memory.
(sleep 600; keep trainer "${CLOCKWORK_RETRAIN_SECONDS:-86400}" plain env MALLOC_ARENA_MAX=2 CLOCKWORK_EMBED_VIA=http://127.0.0.1:4601 bash -c 'cd /app/student && python train.py && python -c "import urllib.request; urllib.request.urlopen(urllib.request.Request(\"http://127.0.0.1:4601/reload\", data=b\"{}\", method=\"POST\"), timeout=60)"') &

trap 'kill 0' TERM INT
wait "$core"
echo "core exited; stopping the instance"
kill 0
