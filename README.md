# git-shit

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
git-shit ship            # pushes the branch and opens a PR into the base (default: staging)
git-shit ship develop    # same, but the PR targets `develop` instead
git-shit ship --draft    # create the PR as a draft (GitHub + gh only)
git-shit merge           # merge the open PR from the terminal, then clean up
git-shit merge --squash  # same, squash-merged (also: --rebase)
git-shit done            # cleanup only: checkout the base, pull, delete branch, prune
```

### `start <name> [base]`

Runs `git flow feature start`. With `base`, the feature branches off `origin/<base>` (freshly fetched) instead of git-flow's default `develop` — e.g. `git-shit start my-fix production` for a fix that belongs on `production`. The base is remembered on the branch, so `ship`, `merge`-cleanup, `done`, and `status` all use it as this branch's default PR target instead of `staging` (an explicit argument still wins, e.g. `git-shit ship develop`).

### `ship [dest] [--draft] [--web]`

1. Verifies you're on a `feature/*` branch with no uncommitted changes, and that the destination branch (default: the base recorded by `start`, else `staging`) exists on `origin`.
2. Publishes the branch (`git flow feature publish`), or just pushes if it's already on `origin`.
3. Creates the PR:
   - **GitHub remote + `gh` logged in** — creates the PR from the terminal with `gh pr create`, title and body taken from your last commit. If the branch already has an open PR, it just tells you (the push already updated it). `--draft` opens it as a draft; `--web` skips `gh` and forces the browser flow.
   - **Bitbucket, or no `gh`** — opens the "new pull request" page in Chrome, pre-filled with source, destination, and title. On macOS it polls the active Chrome tab and auto-clicks **Create pull request** once it renders. Workspace/repo are auto-detected from `origin` (SSH or HTTPS).

### `merge [--merge|--squash|--rebase]` (GitHub + gh)

Merges the current feature's open PR with `gh pr merge` (default: a merge commit), then runs the `done` cleanup against the PR's actual base branch. Refuses if you have unpushed commits, if there's no open PR, or if the PR is still a draft. On Bitbucket, merge in the browser and run `git-shit done` instead.

### `done [dest]`

Run after the PR is merged in the browser (`merge` does this for you). Checks out the destination branch (default: the base recorded by `start`, else `staging`), pulls, deletes the local feature branch, and prunes stale remote-tracking refs. Warns if the branch doesn't appear merged (normal for squash merges).

### `status`

Shows the current branch, its recorded base (if not `staging`), whether it's clean, whether it's published to `origin`, unpushed commits, and ahead/behind counts vs the base. With `gh` on a GitHub remote it also shows the live PR state — number, open/draft/merged, review decision, mergeability, and URL.

## Requirements

- git and [git-flow](https://www.gitkraken.com/learn/git/git-flow), initialised with feature prefix `feature/` (`git flow init`)
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
