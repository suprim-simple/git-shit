# git-shit

git-flow feature workflow that ends in a pull request into `staging` — publish the branch, open the pre-filled Bitbucket or GitHub PR page in Chrome, and auto-click **Create pull request**. You just click **Merge**.

`git flow feature finish` is deliberately not used: it merges locally and pushes directly. With `git-shit`, the merge into `staging` happens through a PR.

## Install

```sh
npm install -g git-shit
```

Because the binary is named `git-shit`, git also picks it up as a subcommand: `git shit ship` works too.

## Usage

```sh
git-shit start my-fix   # runs `git flow feature start my-fix`
# ...do your work, commit as usual...
git-shit status         # where am I? published? ahead/behind staging?
git-shit ship           # pushes the branch, opens the PR page, auto-clicks Create
git-shit ship develop   # same, but the PR targets `develop` instead of `staging`
# ...click Merge in the browser...
git-shit done           # checkout staging, pull, delete the feature branch, prune
```

`ship [dest]`:

1. Verifies you're on a `feature/*` branch with no uncommitted changes, and that the destination branch (default `staging`) exists on `origin`.
2. Publishes the branch (`git flow feature publish`), or just pushes if it's already on `origin`.
3. Opens the "new pull request" page in Chrome, pre-filled with source, destination, and a title taken from your last commit message. Bitbucket and GitHub remotes are both supported — workspace/repo are auto-detected from `origin` (SSH or HTTPS).
4. On macOS, polls the active Chrome tab and clicks **Create pull request** once it renders.

`done [dest]` — run after the PR is merged. Checks out the destination branch (default `staging`), pulls, deletes the local feature branch, and prunes stale remote-tracking refs. Warns if the branch doesn't appear merged (normal for squash merges).

`status` — shows the current branch, whether it's clean, whether it's published to `origin`, unpushed commits, ahead/behind counts vs `staging`, and the PR URL.

## Requirements

- git and [git-flow](https://www.gitkraken.com/learn/git/git-flow), initialised with feature prefix `feature/` (`git flow init`)
- A Bitbucket or GitHub `origin` remote
- Node.js >= 16
- macOS + Google Chrome for the auto-click (on other platforms the PR page still opens; you click Create yourself)

## One-time Chrome setup (for the auto-click)

Chrome menu bar → **View → Developer → Allow JavaScript from Apple Events**, then fully quit Chrome (Cmd+Q) and reopen it.

Your terminal also needs Automation permission for Chrome: **System Settings → Privacy & Security → Automation** → enable Google Chrome under your terminal app. Without either, the script still opens the PR page — you just click Create yourself.

## License

MIT
