#!/bin/sh
# Recon preview sync (local only; installed as post-commit AND post-merge): after a commit or merge on feat/recon-phase1, move the preview worktree that the dev stack on
# :3000 mounts to the new commit — only if that commit passes a quick gate, so the owner never sees :3000 broken by a
# bad commit. Never blocks the commit: the gate runs in the background; every outcome is one line in the log.
# Gate: tsc of apps/api and apps/web on exactly that commit (in a separate check worktree), then after the move
# GET /login = 200 and POST /api/auth/login without credentials answers 4xx (the API is up). A failure keeps or puts
# the preview back at the last healthy commit.
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "feat/recon-phase1" ] || exit 0
NEW=$(git rev-parse HEAD)
REPO=$(git rev-parse --show-toplevel)
# Git sets these for the committing worktree; the preview and the check worktree are others.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY
BASE="/Users/riuzaki/Private Space/Sunny Go/PROJECT-APPS/RECON-ENIGNE"
PREVIEW="$BASE/recon-preview"; CHECK="$BASE/recon-check"
[ -d "$PREVIEW" ] || exit 0
mkdir -p "$PREVIEW/.superpowers"; LOCK="$PREVIEW/.superpowers/gate.lock"; LOG="$PREVIEW/.superpowers/preview-sync.log"; GOOD="$PREVIEW/.superpowers/last-good"

gate() {
  # One gate at a time; a later commit's gate waits, then checks the branch tip (skips stale commits).
  until mkdir "$LOCK" 2>/dev/null; do sleep 2; done
  TIP=$(git -C "$REPO" rev-parse feat/recon-phase1)
  [ "$TIP" = "$NEW" ] || { echo "$(date '+%F %T') skip $(echo "$NEW" | cut -c1-7): newer commit $(echo "$TIP" | cut -c1-7)" >> "$LOG"; return; }
  S=$(echo "$NEW" | cut -c1-7)
  [ -d "$CHECK" ] || git -C "$REPO" worktree add -q --detach "$CHECK" "$NEW" 2>>"$LOG"
  for d in node_modules apps/api/node_modules apps/web/node_modules packages/shared/node_modules packages/ui/node_modules; do
    [ -e "$CHECK/$d" ] || ln -s "$REPO/$d" "$CHECK/$d"
  done
  git -C "$CHECK" checkout -q --detach -f "$NEW" 2>>"$LOG"
  for app in api web; do
    if ! (cd "$CHECK/apps/$app" && bunx tsc --noEmit -p . > "$PREVIEW/.superpowers/gate-$app.txt" 2>&1); then
      echo "$(date '+%F %T') gate FAILED for $S: tsc apps/$app ($(head -1 "$PREVIEW/.superpowers/gate-$app.txt")); preview stays at $(git -C "$PREVIEW" rev-parse --short HEAD)" >> "$LOG"
      return
    fi
  done
  OLD=$(git -C "$PREVIEW" rev-parse HEAD)
  git -C "$PREVIEW" checkout --detach -q "$NEW" 2>>"$LOG" || { echo "$(date '+%F %T') preview checkout failed for $S" >> "$LOG"; return; }
  # A changed bun.lock needs an install inside the container: restart the app (docker-dev.sh installs on start).
  if ! git -C "$REPO" diff --quiet "$OLD" "$NEW" -- bun.lock 2>/dev/null; then
    COMPOSE_PROJECT_NAME=recon-dev docker compose -f "$PREVIEW/docker-compose.dev.yml" restart app worker >>"$LOG" 2>&1
    WAIT=600
  else
    WAIT=120
    # The API and the worker run under bun --watch, which does not see a change inside a workspace package
    # (packages/shared contracts, packages/ui/src/lib): touching their entry files restarts both on the new code.
    if ! git -C "$REPO" diff --quiet "$OLD" "$NEW" -- packages/shared packages/ui/src/lib 2>/dev/null; then
      touch "$PREVIEW/apps/api/src/index.ts" "$PREVIEW/apps/api/src/worker.ts"
    fi
    # A new migration: applied in the app container (its database is the stack's own), before the health check
    if ! git -C "$REPO" diff --quiet "$OLD" "$NEW" -- apps/api/drizzle 2>/dev/null; then
      docker exec recon-dev-app-1 sh -c 'cd apps/api && bun run db:migrate' >>"$LOG" 2>&1 || echo "$(date '+%F %T') migrate failed for $S" >> "$LOG"
    fi
  fi
  # Health after the reload: poll until both answer or the wait runs out.
  T=0; WEB=000; API=000
  while [ $T -lt $WAIT ]; do
    sleep 5; T=$((T + 5))
    WEB=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://localhost:3000/login)
    API=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "Origin: http://localhost:3000" -H "Content-Type: application/json" -d '{}' http://localhost:3000/api/auth/login)
    case "$WEB:$API" in 200:4??) break ;; esac
  done
  case "$WEB:$API" in
    200:4??) echo "$NEW" > "$GOOD"; echo "$(date '+%F %T') preview at $S (gate passed)" >> "$LOG" ;;
    *) BACK=$(cat "$GOOD" 2>/dev/null || echo "$OLD")
       git -C "$PREVIEW" checkout --detach -q "$BACK" 2>>"$LOG"
       echo "$(date '+%F %T') gate FAILED for $S: /login $WEB, /api $API after ${T}s; preview back at $(echo "$BACK" | cut -c1-7)" >> "$LOG" ;;
  esac
}
# The lock is released by the caller (a trap inside a backgrounded function does not fire in sh).
(gate >/dev/null 2>&1; rmdir "$LOCK" 2>/dev/null) &
exit 0
