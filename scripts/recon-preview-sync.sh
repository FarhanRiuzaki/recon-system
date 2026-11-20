#!/bin/sh
# Recon preview sync (local only): after a commit on feat/recon-phase1, move the preview worktree that the dev stack on
# :3000 mounts to the new commit, so the app shows committed code only. Never blocks the commit; failures go to the log.
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "feat/recon-phase1" ] || exit 0
NEW=$(git rev-parse HEAD)
# Git sets these for the committing worktree; the preview is another worktree.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_OBJECT_DIRECTORY
PREVIEW="/Users/riuzaki/Private Space/Sunny Go/PROJECT-APPS/RECON-ENIGNE/recon-preview"
mkdir -p "$PREVIEW/.superpowers"; LOG="$PREVIEW/.superpowers/preview-sync.log"
[ -d "$PREVIEW" ] || exit 0
OLD=$(git -C "$PREVIEW" rev-parse HEAD 2>/dev/null)
if git -C "$PREVIEW" checkout --detach -q "$NEW" 2>>"$LOG"; then
  echo "$(date '+%F %T') preview at $(git -C "$PREVIEW" rev-parse --short HEAD)" >> "$LOG"
  # A changed bun.lock needs an install inside the container: restart the app (docker-dev.sh installs on start).
  if [ -n "$OLD" ] && ! git diff --quiet "$OLD" "$NEW" -- bun.lock 2>/dev/null; then
    (COMPOSE_PROJECT_NAME=recon-dev docker compose -f "$PREVIEW/docker-compose.dev.yml" restart app worker >>"$LOG" 2>&1 &)
    echo "$(date '+%F %T') bun.lock changed: restarting app and worker" >> "$LOG"
  fi
else
  echo "$(date '+%F %T') preview sync failed for $NEW" >> "$LOG"
fi
exit 0
