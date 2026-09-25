#!/usr/bin/env bash
# Publish Archiver to GitHub as a new repo named "Archiver".
#
#   ./publish.sh                 # uses gh if you're already logged in
#   GITHUB_TOKEN=ghp_xxx ./publish.sh
#
set -euo pipefail
cd "$(dirname "$0")"

REPO="${REPO:-Archiver}"
VISIBILITY="${VISIBILITY:-public}"

command -v gh >/dev/null 2>&1 || {
  echo "gh CLI not found. Install it: https://cli.github.com/" >&2
  exit 1
}

if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "$GITHUB_TOKEN" | gh auth login --with-token
fi

gh auth status >/dev/null 2>&1 || {
  echo "Not authenticated. Run: gh auth login" >&2
  exit 1
}

# Never publish the memory bank, even if someone force-adds it.
if git ls-files | grep -qE '\.db(-wal|-shm)?$'; then
  echo "Refusing to publish: a *.db file is staged." >&2
  exit 1
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -m "Update Archiver"
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "origin already set: $(git remote get-url origin)"
  git push -u origin HEAD
else
  gh repo create "$REPO" --"$VISIBILITY" --source=. --remote=origin --push \
    --description "An LLM chat app that saves memory — one SQLite file you own."
fi

echo
echo "Published: $(git remote get-url origin)"
