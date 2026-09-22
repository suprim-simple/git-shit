# Git-shit start, ship...

[![CI](https://github.com/suprim-simple/git-shit/actions/workflows/ci.yml/badge.svg)](https://github.com/suprim-simple/git-shit/actions/workflows/ci.yml)

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
git-shit start part-2 --on=my-fix # stack part-2 on my-fix (its PR targets my-fix)
git-shit checkout        # interactive list of local branches — pick one to check out (+ pull latest)
git-shit checkout my-fix # switch straight to a branch (falls back to feature/my-fix), then pull latest
# ...do your work, commit as usual...
git-shit status          # where am I? published? PR state? ahead/behind the base?
git-shit sync            # catch the branch up to its base (rebase origin/staging in)
git-shit sync --merge    # same, but merge the base in instead of rebasing
git-shit ship            # pushes the branch and opens a PR into the base (default: staging)
git-shit ship develop    # same, but the PR targets `develop` instead
git-shit ship --draft    # create the PR as a draft (GitHub + gh only)
git-shit push            # push the current branch (offers to commit a dirty tree first)
git-shit push --force    # same, with --force-with-lease (safe after a rebase)
git-shit pull            # pull the current branch from origin (--rebase to rebase)
git-shit merge           # merge the open PR from the terminal, then clean up
git-shit merge --squash  # same, squash-merged (also: --rebase)
git-shit merge --when-green  # wait for checks to pass, then merge + notify
git-shit done            # cleanup only: checkout the base, pull, delete branch, prune
git-shit list            # interactive board of every feature/* branch (--plain for a static table)
git-shit issues          # auto-refreshing board of open GitHub issues; Enter starts a branch for one
git-shit issues --mine   # same, limited to issues assigned to you
git-shit completion zsh  # print a shell-completion script (also: bash, fish)
git-shit help            # show usage (also --help, -h)
git-shit version         # show version (also --version, -v)
```

The default PR target is `staging`, but it's configurable — see [Configuration](#configuration).

### `start <name> [base] [--on=<parent>]`

Runs `git flow feature start`. With `base`, the feature branches off `origin/<base>` (freshly fetched) instead of git-flow's default `develop` — e.g. `git-shit start my-fix production` for a fix that belongs on `production`. The base is remembered on the branch, so `ship`, `merge`-cleanup, `done`, and `status` all use it as this branch's default PR target instead of `staging` (an explicit argument still wins, e.g. `git-shit ship develop`).

`git flow init` isn't required. In a repo where git-flow isn't initialised, `start` skips `git flow feature start` and creates the branch with a plain `git checkout -b` — off `origin/<base>` when you pass a base, off the `--on` parent when you stack, and otherwise off `origin/develop` (falling back to the default base, a local `develop`, then the current `HEAD`). Everything downstream (`ship`, `sync`, `merge`, `done`) already works without git-flow, so the whole workflow runs either way.

With `--on=<parent>` it stacks the new branch on another **feature branch** instead of a long-lived base — see [Stacked PRs](#stacked-prs).

### `checkout [name] [--plain] [--no-pull]`

Switch branches **and land on the latest** — after checking out, it fast-forwards the branch to its upstream (`git pull --ff-only`), so you don't start work on a stale branch. It only fast-forwards: if the branch has diverged it says so and leaves your tree untouched (run `git-shit sync`/`pull`), and a branch with no upstream is left as-is. Pass `--no-pull` to just switch without pulling.

With a `name`, it checks that branch out directly, like `git checkout` — and if the exact name doesn't exist but `feature/<name>` does, it switches to that (so `git-shit checkout my-fix` finds `feature/my-fix`).

With **no argument**, it opens an interactive list of your local branches (most-recently-committed first, current one marked `*`), each with its last-commit age and subject:

```
git-shit checkout  ·  5 branch(es)

  BRANCH             AGE            LAST COMMIT
  develop            2 hours ago    Wire up the API
  feature/login      5 hours ago    Add the login form
  hotfix/crash       1 day ago      Guard against null user
* main               3 days ago     Initial commit

↑/↓ move · PgUp/PgDn page · enter checkout · r refresh · q quit
```

Arrow keys (or `j`/`k`) move, PgUp/PgDn page through long lists, `r` refreshes the list (fetches origin and re-reads your branches), and Enter checks out the highlighted branch (fast-forwarding it as above). `--plain` (or piping) prints the static table instead. It's plain git underneath — no `gh`/GitHub needed.

### Stacked PRs

Break a big change into a chain of small, reviewable PRs where each builds on the last — without waiting for the first to merge. `gh` has no notion of this; `git-shit` records the parent as the child's base and keeps the stack honest for you.

```sh
git-shit start api                 # feature/api  -> staging
# ...commit, then...
git-shit ship                      # PR: feature/api -> staging
git-shit start ui --on=api         # feature/ui   -> feature/api  (stacked)
# ...commit, then...
git-shit ship                      # PR: feature/ui -> feature/api
```

- **`start <name> --on=<parent>`** branches off the local parent's tip and records the parent as this branch's PR target. `<parent>` can be the short name (`api`) or the full branch (`feature/api`).
- **`ship`** on a stacked branch opens the PR against its parent, and the PR body lists only the commits this branch adds on top of the parent. The parent must be shipped (on `origin`) first — if it isn't, `ship` tells you to ship it before the child.
- **When the parent merges** — via `git-shit merge`, or a browser merge followed by `git-shit done` — each direct child is automatically **restacked** onto the parent's base: rebased with `git rebase --onto` (dropping the parent's now-merged commits), its recorded base and open-PR target retargeted, and force-pushed. If a rebase hits conflicts, that child is left untouched and the exact manual command is printed. Deeper descendants keep their own parent; catch them up with `git-shit sync` once their parent is restacked.

`status` and `list` both show the stack — `status` labels the base as a *stacked parent*, and `list` indents each child under its parent.

### `ship [dest] [--draft] [--web] [--reviewer=…] [--label=…] [--assignee=…]`

1. Verifies you have no uncommitted changes and that the destination branch (default: the base recorded by `start`, else `staging`) exists on `origin`. A `feature/*` branch is the normal case, but any branch can ship — off a `feature/*` branch it just prints a note and carries on (it only refuses to ship a branch into itself). If the tree is dirty and you're in a terminal, `ship` shows the changes and offers to stage them all (`git add -A`) and commit them for you — it prints the `git status`, asks for confirmation, then prompts for a commit message and commits before continuing. Decline (or run non-interactively, e.g. in a script) and it falls back to the old behaviour: it stops and asks you to commit or stash first, without touching your tree.
2. Publishes the branch — `git flow feature publish` for a `feature/*` branch in a git-flow-initialised repo, otherwise a plain `git push -u origin <branch>` — or just pushes if it's already on `origin`. So `ship` works even in a repo where you never ran `git flow init` (a `feature/*` branch there is just published with a plain push).
3. Creates the PR:
   - **GitHub remote + `gh` logged in** — creates the PR from the terminal with `gh pr create`. The title and body come from the branch's commits: a single-commit branch uses that commit's subject and full message body, while a multi-commit branch uses the first commit's subject as the title and a bullet list of every commit subject as the body. If the repo has a [pull-request template](#pr-title-and-body), it's used as the body instead. If the branch already has an open PR, it just tells you (the push already updated it). `--draft` opens it as a draft; `--web` skips `gh` and forces the browser flow.
   - **Bitbucket, or no `gh`** — opens the "new pull request" page in Chrome, pre-filled with source, destination, and title. On macOS it polls the active Chrome tab and auto-clicks **Create pull request** once it renders. Workspace/repo are auto-detected from `origin` (SSH or HTTPS).

**Reviewers, labels, and assignees** (GitHub + `gh`, on PR creation): pass `--reviewer=alice,bob`, `--label=feature,needs-qa`, or `--assignee=@me` (comma-separated, use the `=` form). Each is unioned with a per-repo default from git config — set `gitshit.reviewers`, `gitshit.labels`, and `gitshit.assignees` once and every PR gets them for free (see [Configuration](#configuration)). They only apply when a new PR is created, and are ignored (with a note) in the Bitbucket/browser flow.

### PR title and body

When creating a PR with `gh`, `git-shit` fills the title and body from the commits your branch adds on top of the base:

- **One commit** — the title is its subject and the body is its full message body (the common case if you keep one commit per branch).
- **Several commits** — the title is the **first** commit's subject and the body is a bullet list of every commit subject, oldest first — a ready-made summary rather than just the tip commit.
- **Pull-request template** — if the repo has one (`.github/pull_request_template.md`, `PULL_REQUEST_TEMPLATE.md`, `docs/…`, and the usual variants), its contents become the body so your team's checklist/format is preserved; the title still comes from the commits.

Either way it's just the starting point — edit the PR on GitHub afterwards if you want. (The Bitbucket/browser fallback only pre-fills the title.)

### `push [--force]`

Plain `git push` for the current branch, with the same dirty-tree convenience as `ship` but no PR. If the working tree is dirty and you're in a terminal, it shows the changes and offers to stage them all (`git add -A`) and commit them — printing `git status`, asking to confirm, then prompting for a commit message — before pushing. Decline (or run non-interactively) and it just pushes whatever is already committed, leaving your working tree untouched (it says so). It sets the upstream automatically on the first push, so a later bare `push`/`pull` just works. `--force` uses `--force-with-lease` — the safe force-push you want after a rebase.

Unlike `ship`, `push` opens no PR and needs no `gh`/GitHub — it works on any remote.

### `pull [--rebase]`

Plain `git pull` for the current branch (fast-forward/merge, or `--rebase` to rebase your local commits on top instead). Refuses on a dirty tree — commit or stash first — since a pull that has to merge needs a clean one. If the branch has no upstream yet, it pulls from `origin/<branch>` when that exists, or tells you to `git-shit push` it first.

### `sync [dest] [--merge]`

Brings the latest base into the current branch so it doesn't drift behind while you work (`status` tells you *how far* behind; `sync` is how you catch up). It:

1. Refuses if you have uncommitted changes — a rebase/merge needs a clean tree.
2. Fetches and prunes `origin`, then checks the base (default: the base recorded by `start`, else `staging`) exists there.
3. If the base has no new commits, says so and stops without touching your tree.
4. Otherwise **rebases** your branch onto `origin/<base>` — or **merges** the base in with `--merge`. On conflicts it leaves the in-progress rebase/merge in place and prints exactly how to continue (`git rebase --continue`) or back out (`git rebase --abort`).

If the branch is already published, `sync` reminds you to update the open PR: a rebase rewrote history, so it needs `git push --force-with-lease origin <branch>`; a merge only adds a commit, so a plain `git-shit ship` is enough.

### `merge [--merge|--squash|--rebase] [--when-green]` (GitHub + gh)

Merges the current branch's open PR with `gh pr merge` (default: a merge commit), then runs the `done` cleanup against the PR's actual base branch. Works on a `feature/*` branch or any other branch you shipped (off a `feature/*` branch it prints a note and the cleanup leaves the local branch in place). Refuses if you have unpushed commits, if there's no open PR, or if the PR is still a draft. On Bitbucket, merge in the browser and run `git-shit done` instead.

With **`--when-green`** it doesn't merge right away — it polls the PR's checks every 20s and merges only once they're all passing, then cleans up. A failing check stops it (no merge); a PR with no checks merges immediately. Either way you get a desktop notification (plus a terminal bell) when it merges or a check fails, so you can kick it off and walk away. `gh pr merge --auto` queues a merge on GitHub's side but doesn't do the local `done` cleanup or notify you — this closes that loop. (Stop the wait any time with Ctrl-C; it gives up after an hour.)

### `done [dest]`

Run after the PR is merged in the browser (`merge` does this for you). Checks out the destination branch (default: the base recorded by `start`, else `staging`), pulls, deletes the local feature branch, and prunes stale remote-tracking refs. Warns if the branch doesn't appear merged (normal for squash merges).

### `status`

Shows the current branch, its recorded base (if not `staging`), whether it's clean, whether it's published to `origin`, unpushed commits, and ahead/behind counts vs the base. With `gh` on a GitHub remote it also shows the live PR state — number, open/draft/merged, review decision, mergeability, and URL.

### `list [--plain]`

A dashboard of **all** your in-flight work — every local `feature/*` branch at once, most-recently-worked first, instead of one branch at a time. For each it shows the base, publish state, and (with `gh` on a GitHub remote) the live PR state — number, open/draft/merged, a check-run summary (`checks: ok`, `checks: 2/3`, or `checks: 1 failing`), and the review decision. The current branch is marked with `*`. When a branch has an open/merged PR, the base column reflects the PR's actual target; otherwise it's the base `ship` would use. [Stacked](#stacked-prs) children are indented under their parent.

```
  BRANCH                 BASE            STATE       PR
* feature/new-nav        main            published   #42 · open · checks: 2/3 · review pending
  feature/api            staging         published   #40 · open · checks: ok · approved
  └─ feature/ui          feature/api     published   #41 · open · checks: ok · review pending
  feature/spike          develop         local only  —
```

**Interactive board.** In a terminal, `list` is a keyboard-driven cockpit rather than a static report — arrow keys (or `j`/`k`) move the selection, and you act on the highlighted branch without leaving the board:

| key | action |
|-----|--------|
| `o` / Enter | open the PR (or its compare page) in the browser |
| `c` | check out the branch |
| `s` | ship it (`git-shit ship`) |
| `m` | merge it (`git-shit merge`) |
| `r` | refresh the data |
| `q` | quit |

Pass `--plain` (or pipe/redirect the output) for the static table above — that's what scripts and non-terminals get automatically.

One `git ls-remote` (publish state) and one `gh pr list` (PR state) back the whole table; they run **in parallel behind a progress spinner**, so the wait is the slower of the two (not their sum) and you always see it's working. `status`, `ship`, and `merge` show the same spinner while they talk to GitHub. On Bitbucket, or without `gh`, the PR columns are omitted.

### `issues [--plain] [--mine]` (GitHub + gh)

Pick the issue you're about to work on and start a branch for it — without leaving the terminal. `issues` shows an **auto-refreshing** board of the repo's open issues (number, title, labels, assignee, age), polled every 15s so it stays current while it sits open, and on selection it runs `start` for you.

```
git-shit issues  ·  2 open · acme/widgets · synced 1:53:36 PM

  #     TITLE                      LABELS  WHO            AGE
  #123  Fix the flaky login test!  bug     suprim-simple  18h
  #124  Add dark mode                      —              now

↑/↓ move · enter start branch · o open · a mine · r refresh · q quit
```

| key | action |
|-----|--------|
| ↑/↓ (or `j`/`k`) | move the selection |
| PgUp/PgDn (or Space / `Ctrl-B`/`Ctrl-F`) | page a screenful at a time |
| `g` / `G` | jump to the first / last issue |
| Enter | **start a branch** for the selected issue and link it (then exit the board) |
| `o` | open the issue in the browser |
| `a` | toggle between all open issues and just yours |
| `r` | refresh now |
| `q` | quit |

**Enter** starts a feature branch named `<number>-<slug-of-title>` (e.g. `feature/123-fix-the-flaky-login-test`) off your default base, and records the issue number on the branch. That link means the next **`git-shit ship`** appends `Closes #123` to the PR body, so merging the PR closes the issue automatically (unless the body already references it). `--mine` starts the board filtered to issues assigned to you; `--plain` (or piping) prints the static table for scripts.

**Big backlogs.** The board only renders the rows that fit your terminal and pages through the rest, so it stays fast and legible no matter how many issues are open (it resizes with the window, and keeps your cursor on the same issue across auto-refreshes). One `gh` call fetches up to 200 open issues per refresh; beyond that, narrow with `--mine`.

By default a "page" is however many issues fit your terminal height. To page a **fixed** number at a time instead — regardless of window size — set a page size:

```sh
git config gitshit.issuesPerPage 10   # page 10 issues at a time
```

(The fetch cap and the page size are separate: the cap is how many issues are pulled from GitHub, the page size is how many show per screen.)

Needs a GitHub remote with `gh` logged in — it's GitHub-only for now.

### `completion <bash|zsh|fish>`

Prints a shell-completion script for `git-shit` to stdout — completes subcommands and their flags. Load it from your shell config:

```sh
# bash — in ~/.bashrc
source <(git-shit completion bash)
# zsh — in ~/.zshrc (after compinit)
source <(git-shit completion zsh)
# fish
git-shit completion fish > ~/.config/fish/completions/git-shit.fish
```

## Configuration

The default PR target — used by `ship`, `merge`-cleanup, `done`, and `status` when a branch has no base recorded by `start` and you don't pass an explicit `dest` — is `staging`. Change it per-repo (or everywhere with `--global`):

```sh
git config gitshit.base develop          # this repo
git config --global gitshit.base develop # all repos
```

Precedence, highest first: an explicit `dest` argument (`git-shit ship main`) → the base recorded on the branch by `git-shit start <name> <base>` → `gitshit.base` → the built-in default `staging`.

### Default reviewers, labels, and assignees

Set defaults that `ship` applies to every new PR (GitHub + `gh`). Values are comma-separated; any `--reviewer=`/`--label=`/`--assignee=` flag on a given `ship` is unioned in on top.

```sh
git config gitshit.reviewers alice,bob
git config gitshit.labels    feature,needs-qa
git config gitshit.assignees @me
```

## Requirements

- git; [git-flow](https://www.gitkraken.com/learn/git/git-flow) is optional — every command, `start` included, works without it (`start` falls back to a plain `git checkout -b`). If you do use git-flow, initialise it with feature prefix `feature/` (`git flow init`) and `start`/`ship` will use it automatically
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
