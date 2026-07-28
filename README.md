# git-shit

[![CI](https://github.com/suprim-simple/git-shit/actions/workflows/ci.yml/badge.svg)](https://github.com/suprim-simple/git-shit/actions/workflows/ci.yml)

git-flow feature workflow that ends in a pull request into `staging` — publish the branch, then create (and merge) the PR **straight from the terminal with the [GitHub CLI](https://cli.github.com)**. On Bitbucket, or without `gh`, it falls back to opening the pre-filled PR page in Chrome and auto-clicking **Create pull request**.

`git flow feature finish` is deliberately not used: it merges locally and pushes directly. With `git-shit`, the merge into `staging` happens through a PR.

## Install

```sh
npm install -g git-shit
```

Because the binary is named `git-shit`, git also picks it up as a subcommand: `git shit ship` works too.

For the terminal PR flow on GitHub remotes, also install the GitHub CLI and log in once:

```sh
brew install gh   # or see https://cli.github.com
gh auth login
```

## Usage

```sh
git-shit start my-fix             # runs `git flow feature start my-fix`
git-shit start my-fix production  # same, but branch off origin/production
# ...do your work, commit as usual...
git-shit status          # where am I? published? PR state? ahead/behind the base?
git-shit sync            # catch the branch up to its base (rebase origin/staging in)
git-shit sync --merge    # same, but merge the base in instead of rebasing
git-shit ship            # pushes the branch and opens a PR into the base (default: staging)
git-shit ship develop    # same, but the PR targets `develop` instead
git-shit ship --draft    # create the PR as a draft (GitHub + gh only)
git-shit merge           # merge the open PR from the terminal, then clean up
git-shit merge --squash  # same, squash-merged (also: --rebase)
git-shit done            # cleanup only: checkout the base, pull, delete branch, prune
git-shit help            # show usage (also --help, -h)
git-shit version         # show version (also --version, -v)
```

The default PR target is `staging`, but it's configurable — see [Configuration](#configuration).

### `start <name> [base]`

Runs `git flow feature start`. With `base`, the feature branches off `origin/<base>` (freshly fetched) instead of git-flow's default `develop` — e.g. `git-shit start my-fix production` for a fix that belongs on `production`. The base is remembered on the branch, so `ship`, `merge`-cleanup, `done`, and `status` all use it as this branch's default PR target instead of `staging` (an explicit argument still wins, e.g. `git-shit ship develop`).

### `ship [dest] [--draft] [--web]`

1. Verifies you have no uncommitted changes and that the destination branch (default: the base recorded by `start`, else `staging`) exists on `origin`. A `feature/*` branch is the normal case, but any branch can ship — off a `feature/*` branch it just prints a note and carries on (it only refuses to ship a branch into itself).
2. Publishes the branch — `git flow feature publish` for a `feature/*` branch in a git-flow-initialised repo, otherwise a plain `git push -u origin <branch>` — or just pushes if it's already on `origin`. So `ship` works even in a repo where you never ran `git flow init` (a `feature/*` branch there is just published with a plain push).
3. Creates the PR:
   - **GitHub remote + `gh` logged in** — creates the PR from the terminal with `gh pr create`. The title and body come from the branch's commits: a single-commit branch uses that commit's subject and full message body, while a multi-commit branch uses the first commit's subject as the title and a bullet list of every commit subject as the body. If the repo has a [pull-request template](#pr-title-and-body), it's used as the body instead. If the branch already has an open PR, it just tells you (the push already updated it). `--draft` opens it as a draft; `--web` skips `gh` and forces the browser flow.
   - **Bitbucket, or no `gh`** — opens the "new pull request" page in Chrome, pre-filled with source, destination, and title. On macOS it polls the active Chrome tab and auto-clicks **Create pull request** once it renders. Workspace/repo are auto-detected from `origin` (SSH or HTTPS).

### PR title and body

When creating a PR with `gh`, `git-shit` fills the title and body from the commits your branch adds on top of the base:

- **One commit** — the title is its subject and the body is its full message body (the common case if you keep one commit per branch).
- **Several commits** — the title is the **first** commit's subject and the body is a bullet list of every commit subject, oldest first — a ready-made summary rather than just the tip commit.
- **Pull-request template** — if the repo has one (`.github/pull_request_template.md`, `PULL_REQUEST_TEMPLATE.md`, `docs/…`, and the usual variants), its contents become the body so your team's checklist/format is preserved; the title still comes from the commits.

Either way it's just the starting point — edit the PR on GitHub afterwards if you want. (The Bitbucket/browser fallback only pre-fills the title.)

### `sync [dest] [--merge]`

Brings the latest base into the current branch so it doesn't drift behind while you work (`status` tells you *how far* behind; `sync` is how you catch up). It:

1. Refuses if you have uncommitted changes — a rebase/merge needs a clean tree.
2. Fetches and prunes `origin`, then checks the base (default: the base recorded by `start`, else `staging`) exists there.
3. If the base has no new commits, says so and stops without touching your tree.
4. Otherwise **rebases** your branch onto `origin/<base>` — or **merges** the base in with `--merge`. On conflicts it leaves the in-progress rebase/merge in place and prints exactly how to continue (`git rebase --continue`) or back out (`git rebase --abort`).

If the branch is already published, `sync` reminds you to update the open PR: a rebase rewrote history, so it needs `git push --force-with-lease origin <branch>`; a merge only adds a commit, so a plain `git-shit ship` is enough.

### `merge [--merge|--squash|--rebase]` (GitHub + gh)

Merges the current branch's open PR with `gh pr merge` (default: a merge commit), then runs the `done` cleanup against the PR's actual base branch. Works on a `feature/*` branch or any other branch you shipped (off a `feature/*` branch it prints a note and the cleanup leaves the local branch in place). Refuses if you have unpushed commits, if there's no open PR, or if the PR is still a draft. On Bitbucket, merge in the browser and run `git-shit done` instead.

### `done [dest]`

Run after the PR is merged in the browser (`merge` does this for you). Checks out the destination branch (default: the base recorded by `start`, else `staging`), pulls, deletes the local feature branch, and prunes stale remote-tracking refs. Warns if the branch doesn't appear merged (normal for squash merges).

### `status`

Shows the current branch, its recorded base (if not `staging`), whether it's clean, whether it's published to `origin`, unpushed commits, and ahead/behind counts vs the base. With `gh` on a GitHub remote it also shows the live PR state — number, open/draft/merged, review decision, mergeability, and URL.

## Configuration

The default PR target — used by `ship`, `merge`-cleanup, `done`, and `status` when a branch has no base recorded by `start` and you don't pass an explicit `dest` — is `staging`. Change it per-repo (or everywhere with `--global`):

```sh
git config gitshit.base develop          # this repo
git config --global gitshit.base develop # all repos
```

Precedence, highest first: an explicit `dest` argument (`git-shit ship main`) → the base recorded on the branch by `git-shit start <name> <base>` → `gitshit.base` → the built-in default `staging`.

## Requirements

- git; [git-flow](https://www.gitkraken.com/learn/git/git-flow) is only needed for `git-shit start` — `ship`, `merge`, and `done` work without it. If you do use git-flow, initialise it with feature prefix `feature/` (`git flow init`)
- A Bitbucket or GitHub `origin` remote
- Node.js >= 16
- For terminal PRs on GitHub: the [GitHub CLI](https://cli.github.com) (`gh`), logged in via `gh auth login`
- For the browser fallback auto-click: macOS + Google Chrome (on other platforms the PR page still opens; you click Create yourself)

## One-time Chrome setup (browser fallback only)

Only needed if you use the browser flow (Bitbucket, no `gh`, or `ship --web`):

Chrome menu bar → **View → Developer → Allow JavaScript from Apple Events**, then fully quit Chrome (Cmd+Q) and reopen it.

Your terminal also needs Automation permission for Chrome: **System Settings → Privacy & Security → Automation** → enable Google Chrome under your terminal app. Without either, the script still opens the PR page — you just click Create yourself.

## License

MIT
