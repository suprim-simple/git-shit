#!/usr/bin/env bash
#
# gf-staging.sh — git-flow feature workflow that ends in a PR into staging
#
# Workflow:
#   1. ./gf-staging.sh start my-fix   -> runs `git flow feature start my-fix`
#   2. ...do your work, commit as usual...
#   3. ./gf-staging.sh ship           -> pushes the feature branch, opens the
#                                        pre-filled PR page in Chrome, waits
#                                        for it to load, and auto-clicks
#                                        "Create pull request". You just
#                                        click Merge.
#
# One-time Chrome setup (required for the auto-click):
#   Chrome menu bar -> View -> Developer -> Allow JavaScript from Apple Events
#   (Without it, the script still opens the PR page; you click Create yourself.)
#
# Requires: git, git-flow, macOS (osascript) + Google Chrome for the auto-click
#
# Notes:
#   - Workspace + repo slug are auto-detected from the `origin` remote URL.
#   - Assumes git-flow is initialised (`git flow init`) with feature prefix "feature/".
#   - `git flow feature finish` is deliberately NOT used: it merges locally and
#     pushes directly — here the merge into staging happens through a PR.

set -euo pipefail

BASE_BRANCH="staging"
FEATURE_PREFIX="$(git config gitflow.prefix.feature 2>/dev/null || echo 'feature/')"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") start <name>   Start a new git-flow feature
  $(basename "$0") ship           Push current feature, open PR page, auto-click Create
USAGE
  exit 1
}

resolve_repo() {
  # Parse workspace/repo from the origin remote. Handles:
  #   git@bitbucket.org:workspace/repo.git
  #   https://user@bitbucket.org/workspace/repo.git
  local remote_url
  remote_url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ "$remote_url" =~ bitbucket\.org[:/]([^/]+)/([^/]+)$ ]]; then
    WORKSPACE="${BASH_REMATCH[1]}"
    REPO_SLUG="${BASH_REMATCH[2]%.git}"
  else
    echo "Could not determine workspace/repo from the origin remote:"
    echo "  ${remote_url:-<no origin remote found>}"
    exit 1
  fi
  WEB="https://bitbucket.org/${WORKSPACE}/${REPO_SLUG}"
}

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then        # macOS
    open -a "Google Chrome" "$url" 2>/dev/null || open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then  # Linux
    xdg-open "$url"
  else
    echo "Open this URL in your browser:"
    echo "  $url"
  fi
}

# Poll the active Chrome tab and click "Create pull request" once it renders.
auto_click_create() {
  if ! command -v osascript >/dev/null 2>&1; then
    echo "    (auto-click skipped: not macOS — click Create yourself)"
    return 0
  fi

  echo "==> Waiting for the page to load, then clicking Create pull request..."

  # Write the AppleScript to a temp file first. (Heredocs inside command
  # substitution break on macOS bash 3.2, especially with apostrophes.)
  local osa_file="/tmp/gf-staging-click.applescript"
  local err_file="/tmp/gf-staging-osa.err"

  cat > "$osa_file" <<'APPLESCRIPT'
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      (function () {
        var btn = document.querySelector(
          'button[data-testid=\"create-pull-request-button\"], button[data-qa=\"create-pull-request-button\"]'
        );
        if (!btn) {
          var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
          btn = buttons.filter(function (b) {
            return /create\\s+pull\\s+request/i.test(b.textContent || '');
          })[0];
        }
        if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
        return 'waiting';
      })();
    "
  end tell
end tell
APPLESCRIPT

  local attempts=0 max_attempts=30 result err
  while (( attempts < max_attempts )); do
    sleep 1
    attempts=$((attempts + 1))

    result=$(osascript "$osa_file" 2>"$err_file" || true)
    err=$(cat "$err_file" 2>/dev/null || true)

    if [[ "$result" == "clicked" ]]; then
      echo "==> Create pull request clicked. Review and click Merge in Chrome."
      return 0
    fi

    if [[ -n "$err" ]]; then
      echo "    osascript error:"
      echo "      $err"
      if [[ "$err" == *"-1743"* || "$err" == *"not authorized"* ]]; then
        echo
        echo "    Your terminal app needs Automation permission for Chrome:"
        echo "      System Settings -> Privacy & Security -> Automation"
        echo "      -> enable Google Chrome under your terminal (Terminal/iTerm/VS Code)."
        echo "    If no prompt ever appeared, run this once to trigger it:"
        echo "      osascript -e 'tell application \"Google Chrome\" to get title of front window'"
      elif [[ "$err" == *"turned off"* || "$err" == *"(12)"* ]]; then
        echo
        echo "    Chrome is still blocking scripted JS. After enabling"
        echo "    View -> Developer -> Allow JavaScript from Apple Events,"
        echo "    fully QUIT Chrome (Cmd+Q) and reopen it — the setting"
        echo "    only takes effect after a restart."
      fi
      echo "    (Falling back: click Create pull request yourself.)"
      return 0
    fi

    # result == "waiting" (or empty): button not rendered yet, keep polling
  done

  echo "    Timed out waiting for the button — click Create pull request yourself."
}

cmd_start() {
  local name="${1:?Usage: $(basename "$0") start <name>}"
  echo "==> git flow feature start ${name}"
  git flow feature start "$name"
  echo
  echo "Feature branch '${FEATURE_PREFIX}${name}' created."
  echo "Do your work, commit, then run: $(basename "$0") ship"
}

cmd_ship() {
  resolve_repo

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"

  if [[ "$branch" != ${FEATURE_PREFIX}* ]]; then
    echo "Current branch '${branch}' is not a git-flow feature branch (${FEATURE_PREFIX}*)."
    echo "Check out your feature branch first, or start one with:"
    echo "  $(basename "$0") start <name>"
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "You have uncommitted changes. Commit or stash them before shipping."
    exit 1
  fi

  local feature_name="${branch#"$FEATURE_PREFIX"}"

  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    # Branch already exists on origin — just push the latest commits.
    echo "==> Branch already published, pushing latest commits..."
    git push origin "$branch"
  else
    echo "==> Publishing feature branch (git flow feature publish ${feature_name})..."
    git flow feature publish "$feature_name"
  fi

  local pr_url="${WEB}/pull-requests/new?source=${branch}&dest=${BASE_BRANCH}&t=1"
  echo "==> Opening PR page: ${branch} -> ${BASE_BRANCH}"
  open_url "$pr_url"

  auto_click_create

  echo
  echo "After merging in Chrome, sync up locally with:"
  echo "  git checkout ${BASE_BRANCH} && git pull origin ${BASE_BRANCH}"
  echo "  git branch -D ${branch} && git fetch --prune origin"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  ship)  shift; cmd_ship "$@" ;;
  *)     usage ;;
esac