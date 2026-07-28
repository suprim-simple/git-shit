#!/usr/bin/env node
//
// git-shit — git-flow feature workflow that ends in a PR into staging
//
// Workflow:
//   1. git-shit start my-fix   -> runs `git flow feature start my-fix`
//                                  (add a base to branch off something else,
//                                   e.g. `git-shit start my-fix production` —
//                                   the base then becomes this branch's
//                                   default PR target)
//   2. ...do your work, commit as usual...
//   3. git-shit ship           -> pushes the feature branch and opens a PR.
//                                  GitHub remote + gh CLI logged in: the PR
//                                  is created straight from the terminal.
//                                  Otherwise: opens the pre-filled PR page in
//                                  Chrome and auto-clicks "Create pull request".
//   4. git-shit merge          -> (GitHub + gh) merges the open PR from the
//                                  terminal, then cleans up like `done`.
//                                  Browser flow: click Merge yourself, then
//                                  run `git-shit done`.
//
// One-time Chrome setup (only for the browser-fallback auto-click):
//   Chrome menu bar -> View -> Developer -> Allow JavaScript from Apple Events
//   (Without it, the tool still opens the PR page; you click Create yourself.)
//
// Requires: git. Only `start` needs git-flow; ship/merge/done work without it.
//           Terminal PRs need the GitHub CLI (`gh`, logged in); the browser
//           fallback needs macOS + Google Chrome for the auto-click.
//
// Notes:
//   - Workspace + repo slug are auto-detected from the `origin` remote URL.
//   - If git-flow is initialised (`git flow init`, feature prefix "feature/"),
//     ship publishes feature branches with `git flow feature publish`; without
//     it, ship falls back to a plain `git push -u origin <branch>`.
//   - `git flow feature finish` is deliberately NOT used: it merges locally and
//     pushes directly — here the merge into staging happens through a PR.
//   - `git-shit sync` rebases (or --merge) the latest origin/<base> into the
//     current branch so it stays current before or after the PR is opened.

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_BRANCH = 'staging';
const PROG = 'git-shit';
const { version: VERSION } = require('../package.json');

// The default PR target when a branch has no base recorded by `start` and no
// explicit dest is given. Overridable per-repo/globally with:
//   git config gitshit.base develop
// Falls back to BASE_BRANCH ('staging'). Memoised — the base can't change
// within a single invocation.
let defaultBaseCache = null;
function defaultBase() {
  if (defaultBaseCache === null) {
    try {
      defaultBaseCache = git(['config', 'gitshit.base']) || BASE_BRANCH;
    } catch {
      defaultBaseCache = BASE_BRANCH;
    }
  }
  return defaultBaseCache;
}

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Run a command with output streamed to the terminal; exit on failure.
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') fail(`${cmd}: command not found`);
  if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);
}

function commandExists(cmd) {
  return spawnSync('command', ['-v', cmd], { shell: true, stdio: 'ignore' }).status === 0;
}

function featurePrefix() {
  try {
    return git(['config', 'gitflow.prefix.feature']) || 'feature/';
  } catch {
    return 'feature/';
  }
}

// Has `git flow init` been run in this repo? It records these config keys, and
// `git flow feature publish` needs them — without them the command errors out.
// (featurePrefix() falls back to 'feature/' even when git-flow is absent, so a
// branch can look like a feature branch in a repo that has no git-flow.)
function gitflowInitialized() {
  return (
    spawnSync('git', ['config', '--get', 'gitflow.prefix.feature'], { stdio: 'ignore' }).status === 0
  );
}

// How to publish the current branch to origin. `git flow feature publish` only
// works in a git-flow-initialised repo; everywhere else a plain upstream push
// is the equivalent, so `ship` works with or without git-flow.
//   'push'          -> already on origin: push updates to it
//   'flow'          -> git flow feature publish <name>
//   'push-upstream' -> git push -u origin <branch>
function publishPlan(onOrigin, isFeature, gitflowReady) {
  if (onOrigin) return 'push';
  if (isFeature && gitflowReady) return 'flow';
  return 'push-upstream';
}

// Base recorded by `start <name> <base>` for this feature branch, if any.
// ship/done/status use it as the branch's default PR target. The config entry
// is removed automatically when the branch is deleted.
function branchBase(branch) {
  try {
    return git(['config', `branch.${branch}.gitshitbase`]);
  } catch {
    return '';
  }
}

// --- GitHub CLI (gh) integration --------------------------------------------
// When the origin remote is GitHub and `gh` is installed and logged in, PRs
// are created and merged straight from the terminal — no browser hack needed.
// Bitbucket remotes (or a missing/logged-out gh) keep the browser flow.

let ghOk = null;
function ghUsable(repo) {
  if (repo.host !== 'github') return false;
  if (ghOk === null) {
    ghOk =
      commandExists('gh') &&
      spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' })
        .status === 0;
  }
  return ghOk;
}

// Run gh and parse its JSON output; null on any failure (e.g. no PR found).
function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function usage(exitCode = 1) {
  const base = defaultBase();
  console.log(`${PROG} ${VERSION}

Usage:
  ${PROG} start <name> [base]
                         Start a new git-flow feature. With base, branch off
                         origin/<base> (e.g. production) instead of git-flow's
                         develop, and make <base> the default PR target for
                         this branch.
  ${PROG} ship [dest] [--draft] [--web]
                         Push current feature and open a PR against dest
                         (default: the branch's recorded base, else ${base}).
                         On GitHub with the gh CLI the
                         PR is created from the terminal (--draft for a draft
                         PR, --web to force the browser flow). Bitbucket or no
                         gh: opens the PR page in Chrome and auto-clicks Create.
  ${PROG} sync [dest] [--merge]
                         Catch the current branch up to its base: fetch, then
                         rebase (or --merge) origin/<base> into it (default:
                         the branch's recorded base, else ${base}).
  ${PROG} merge [--merge|--squash|--rebase]
                         Merge the feature's open PR with gh (GitHub only,
                         default: --merge), then clean up like 'done'
  ${PROG} done [dest]    After the PR is merged: checkout dest (default: the
                         branch's recorded base, else ${base}), pull, delete
                         the local feature branch, prune stale refs
  ${PROG} status         Show branch, publish state, PR state, and commits
                         vs the branch's base
  ${PROG} help           Show this help    (also --help, -h)
  ${PROG} version        Show the version  (also --version, -v)

The default PR target is '${base}'. Change it with:
  git config gitshit.base <branch>       (add --global to set it everywhere)`);
  process.exit(exitCode);
}

function resolveRepo() {
  // Parse workspace/repo from the origin remote. Handles:
  //   git@bitbucket.org:workspace/repo.git
  //   https://user@bitbucket.org/workspace/repo.git
  //   git@github.com:owner/repo.git
  //   https://github.com/owner/repo.git
  let remoteUrl = '';
  try {
    remoteUrl = git(['remote', 'get-url', 'origin']);
  } catch {}

  const m = remoteUrl.match(/(bitbucket\.org|github\.com)[:/]([^/]+)\/([^/]+)$/);
  if (!m) {
    fail(
      'Could not determine workspace/repo from the origin remote',
      '(expected a bitbucket.org or github.com URL):',
      `  ${remoteUrl || '<no origin remote found>'}`
    );
  }
  const host = m[1] === 'github.com' ? 'github' : 'bitbucket';
  const workspace = m[2];
  const repoSlug = m[3].replace(/\.git$/, '');
  return { host, web: `https://${m[1]}/${workspace}/${repoSlug}` };
}

// Build the "new PR" URL, pre-filling the title from the last commit subject.
function buildPrUrl(repo, branch, base) {
  let title = '';
  try {
    title = git(['log', '-1', '--pretty=%s']);
  } catch {}

  const b = encodeURIComponent(branch);
  const d = encodeURIComponent(base);
  const t = title ? `&title=${encodeURIComponent(title)}` : '';

  if (repo.host === 'github') {
    return `${repo.web}/compare/${d}...${b}?expand=1${t}`;
  }
  return `${repo.web}/pull-requests/new?source=${b}&dest=${d}&t=1${t}`;
}

function openUrl(url) {
  if (process.platform === 'darwin') {
    let r = spawnSync('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    if (r.status !== 0) spawnSync('open', [url], { stdio: 'ignore' });
  } else if (commandExists('xdg-open')) {
    spawnSync('xdg-open', [url], { stdio: 'ignore' });
  } else {
    console.log('Open this URL in your browser:');
    console.log(`  ${url}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll the active Chrome tab and click "Create pull request" once it renders.
async function autoClickCreate() {
  if (process.platform !== 'darwin' || !commandExists('osascript')) {
    console.log('    (auto-click skipped: not macOS — click Create yourself)');
    return;
  }

  console.log('==> Waiting for the page to load, then clicking Create pull request...');

  const script = `
tell application "Google Chrome"
  tell active tab of front window
    execute javascript "
      (function () {
        var btn = document.querySelector(
          'button[data-testid=\\"create-pull-request-button\\"], button[data-qa=\\"create-pull-request-button\\"]'
        );
        if (!btn) {
          var buttons = Array.prototype.slice.call(document.querySelectorAll('button'));
          btn = buttons.filter(function (b) {
            return /create\\\\s+pull\\\\s+request/i.test(b.textContent || '');
          })[0];
        }
        if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
        return 'waiting';
      })();
    "
  end tell
end tell
`;
  const osaFile = path.join(os.tmpdir(), 'git-shit-click.applescript');
  fs.writeFileSync(osaFile, script);

  const maxAttempts = 30;
  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    await sleep(1000);

    const r = spawnSync('osascript', [osaFile], { encoding: 'utf8' });
    const result = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();

    if (result === 'clicked') {
      console.log('==> Create pull request clicked. Review and click Merge in Chrome.');
      return;
    }

    if (err) {
      console.log('    osascript error:');
      console.log(`      ${err}`);
      if (err.includes('-1743') || err.includes('not authorized')) {
        console.log('');
        console.log('    Your terminal app needs Automation permission for Chrome:');
        console.log('      System Settings -> Privacy & Security -> Automation');
        console.log('      -> enable Google Chrome under your terminal (Terminal/iTerm/VS Code).');
        console.log('    If no prompt ever appeared, run this once to trigger it:');
        console.log('      osascript -e \'tell application "Google Chrome" to get title of front window\'');
      } else if (err.includes('turned off') || err.includes('(12)')) {
        console.log('');
        console.log('    Chrome is still blocking scripted JS. After enabling');
        console.log('    View -> Developer -> Allow JavaScript from Apple Events,');
        console.log('    fully QUIT Chrome (Cmd+Q) and reopen it — the setting');
        console.log('    only takes effect after a restart.');
      }
      console.log('    (Falling back: click Create pull request yourself.)');
      return;
    }

    // result === "waiting" (or empty): button not rendered yet, keep polling
  }

  console.log('    Timed out waiting for the button — click Create pull request yourself.');
}

function cmdStart(name, base) {
  if (!name) fail(`Usage: ${PROG} start <name> [base]`);
  const prefix = featurePrefix();
  const branch = `${prefix}${name}`;

  // A stale remote-tracking ref (branch deleted on origin but never pruned
  // locally) makes `git flow feature start` refuse the name — prune first.
  console.log('==> git fetch --prune origin');
  spawnSync('git', ['fetch', '--prune', 'origin'], { stdio: 'inherit' });

  const existsLocally =
    spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: 'ignore',
    }).status === 0;
  if (existsLocally) {
    fail(
      `Branch '${branch}' already exists locally.`,
      'Resume work on it with:',
      `  git checkout ${branch}`
    );
  }

  const onOrigin =
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    }).status === 0;
  if (onOrigin) {
    fail(
      `Branch '${branch}' still exists on origin (its PR was likely merged`,
      'without "delete source branch" checked).',
      'Resume work on it with:',
      `  git checkout ${branch}`,
      'Or delete it and get the name back:',
      `  git push origin --delete ${branch}`,
      `  ${PROG} start ${name}`
    );
  }

  // Resolve the base to branch from (default: git-flow's develop branch).
  // Prefer the just-fetched origin/<base> so the feature starts from the
  // latest remote state, not a possibly stale local branch.
  let baseRef = '';
  if (base) {
    const baseOnOrigin =
      spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${base}`], {
        stdio: 'ignore',
      }).status === 0;
    const baseLocal =
      spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${base}`], {
        stdio: 'ignore',
      }).status === 0;
    if (baseOnOrigin) {
      baseRef = `origin/${base}`;
    } else if (baseLocal) {
      baseRef = base;
      console.log(`    (base '${base}' not found on origin — using the local branch)`);
    } else {
      fail(
        `Base branch '${base}' not found on origin or locally.`,
        `Usage: ${PROG} start <name> [base]`
      );
    }
  }

  console.log(`==> git flow feature start ${name}${baseRef ? ` ${baseRef}` : ''}`);
  run('git', ['flow', 'feature', 'start', name, ...(baseRef ? [baseRef] : [])]);

  if (base) {
    // Branching off origin/<base> makes git track it as upstream — drop that
    // so `git pull` / the Published check don't point at the base branch.
    // (`git flow feature publish` sets the real upstream later.)
    spawnSync('git', ['branch', '--unset-upstream', branch], { stdio: 'ignore' });
    // Remember the base: ship/done/status default to it for this branch.
    run('git', ['config', `branch.${branch}.gitshitbase`, base]);
  }

  console.log('');
  console.log(`Feature branch '${branch}' created${baseRef ? ` from ${baseRef}` : ''}.`);
  if (base) console.log(`PRs from this branch will target '${base}' by default.`);
  console.log(`Do your work, commit, then run: ${PROG} ship`);
}

// --- PR title & body --------------------------------------------------------
// A single-commit branch keeps its commit subject as the title and its full
// message body as the PR body (the common case). A multi-commit branch uses
// the first commit's subject as the title and a bullet list of every commit
// subject as the body — a ready-made summary instead of just the tip commit.
// If the repo has a pull-request template, that wins as the body so the team's
// format/checklist is preserved (matching how `gh` itself treats templates).

function prTemplate() {
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel']);
  } catch {
    return '';
  }
  // Common GitHub template locations — the first existing file wins.
  const candidates = [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/pull_request_template.markdown',
    'pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'docs/PULL_REQUEST_TEMPLATE.md',
  ];
  for (const rel of candidates) {
    try {
      const p = path.join(root, rel);
      if (fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8').trim();
    } catch {}
  }
  return '';
}

function prTitleBody(base, branch) {
  // Subjects of the commits this branch adds on top of origin/<base>, oldest
  // first. Empty if the range can't be resolved (e.g. no origin/<base> ref).
  let subjects = [];
  try {
    const out = git(['log', '--reverse', '--pretty=format:%s', `origin/${base}..${branch}`]);
    if (out) subjects = out.split('\n');
  } catch {}

  let title = subjects[0] || '';
  if (!title) {
    try {
      title = git(['log', '-1', '--pretty=format:%s', branch]);
    } catch {}
  }

  const template = prTemplate();
  let body;
  if (template) {
    body = template;
  } else if (subjects.length > 1) {
    body = subjects.map((s) => `- ${s}`).join('\n');
  } else {
    // Single commit (or an unresolvable range): use its full message body.
    try {
      body = git(['log', '-1', '--pretty=format:%b', branch]).trim();
    } catch {
      body = '';
    }
  }

  return { title: title || branch, body };
}

// Create the PR with `gh pr create` (or recognise the one already open).
function shipViaGh(branch, baseBranch, draft) {
  const existing = ghJson(['pr', 'view', branch, '--json', 'number,url,state,isDraft']);
  if (existing && existing.state === 'OPEN') {
    console.log(
      `==> PR #${existing.number}${existing.isDraft ? ' (draft)' : ''} already open — it now has your latest commits.`
    );
    console.log(`    ${existing.url}`);
  } else {
    const { title, body } = prTitleBody(baseBranch, branch);

    console.log(`==> Creating PR via gh: ${branch} -> ${baseBranch}${draft ? ' (draft)' : ''}`);
    const args = [
      'pr', 'create',
      '--base', baseBranch,
      '--head', branch,
      '--title', title || branch,
      '--body', body,
    ];
    if (draft) args.push('--draft');
    run('gh', args);
  }

  console.log('');
  console.log(`Check reviews/checks with: ${PROG} status`);
  console.log(`When it's ready, merge and clean up with: ${PROG} merge`);
}

async function cmdShip(dest, opts = {}) {
  const repo = resolveRepo();
  const prefix = featurePrefix();

  const useGh = !opts.web && ghUsable(repo);
  if (opts.draft && !useGh) {
    fail(
      '--draft requires a GitHub remote with the gh CLI installed and logged in',
      '(https://cli.github.com), and cannot be combined with --web.'
    );
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = dest || branchBase(branch) || defaultBase();
  const isFeature = branch.startsWith(prefix);

  if (!isFeature) {
    // Not a git-flow feature branch — ship it anyway with a plain push below
    // instead of `git flow feature publish` (which requires the feature prefix).
    console.log(`Note: '${branch}' is not a git-flow feature branch (${prefix}*) — shipping it anyway.`);
  }

  if (branch === baseBranch) {
    fail(
      `Current branch '${branch}' is also the PR target — nothing to ship.`,
      `Pick a different destination, e.g. ${PROG} ship <dest>.`
    );
  }

  if (git(['status', '--porcelain']) !== '') {
    fail('You have uncommitted changes. Commit or stash them before shipping.');
  }

  const featureName = isFeature ? branch.slice(prefix.length) : '';

  // Drop stale remote-tracking refs (e.g. the branch was deleted on origin
  // when a previous PR merged). `git flow feature publish` checks local
  // origin/* refs, not the server, and refuses if a stale one lingers.
  console.log('==> git fetch --prune origin');
  run('git', ['fetch', '--prune', 'origin']);

  const destOnOrigin =
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', baseBranch], {
      stdio: 'ignore',
    }).status === 0;
  if (!destOnOrigin) {
    fail(
      `Destination branch '${baseBranch}' does not exist on origin.`,
      `Usage: ${PROG} ship [dest]   (default: ${defaultBase()})`
    );
  }

  const onOrigin =
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    }).status === 0;

  const plan = publishPlan(onOrigin, isFeature, gitflowInitialized());
  if (plan === 'push') {
    // Branch already exists on origin — just push the latest commits.
    console.log('==> Branch already published, pushing latest commits...');
    run('git', ['push', 'origin', branch]);
  } else if (plan === 'flow') {
    console.log(`==> Publishing feature branch (git flow feature publish ${featureName})...`);
    run('git', ['flow', 'feature', 'publish', featureName]);
  } else {
    if (isFeature) {
      // A feature-named branch in a repo without git-flow — publish it with a
      // plain push instead of erroring on `git flow feature publish`.
      console.log('    (git-flow not initialised here — publishing with a plain push)');
    }
    console.log(`==> Publishing branch (git push -u origin ${branch})...`);
    run('git', ['push', '-u', 'origin', branch]);
  }

  if (useGh) {
    shipViaGh(branch, baseBranch, opts.draft);
    return;
  }

  if (repo.host === 'github' && !opts.web) {
    console.log('    (tip: install the GitHub CLI and run `gh auth login` to create');
    console.log('     PRs straight from the terminal: https://cli.github.com)');
  }

  const prUrl = buildPrUrl(repo, branch, baseBranch);
  console.log(`==> Opening PR page: ${branch} -> ${baseBranch}`);
  openUrl(prUrl);

  await autoClickCreate();

  console.log('');
  console.log('After merging in the browser, clean up locally with:');
  // `done` with no arg resolves the base the same way (recorded base, else the
  // configured default) — only spell out dest when it differs from that.
  const doneDefault = branchBase(branch) || defaultBase();
  console.log(`  ${PROG} done${baseBranch === doneDefault ? '' : ` ${baseBranch}`}`);
}

// Bring the latest base into the current branch: fetch, then rebase (default)
// or merge origin/<base>. `status` reports when a branch has fallen behind its
// base; `sync` is how you catch it back up before (or after) opening the PR.
function cmdSync(dest, opts = {}) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = dest || branchBase(branch) || defaultBase();
  const strategy = opts.merge ? 'merge' : 'rebase';

  if (branch === baseBranch) {
    fail(
      `Current branch '${branch}' is its own base — nothing to sync.`,
      'Switch to your feature branch first.'
    );
  }

  if (git(['status', '--porcelain']) !== '') {
    fail(
      'You have uncommitted changes. Commit or stash them before syncing.',
      `(a ${strategy} needs a clean working tree)`
    );
  }

  console.log('==> git fetch --prune origin');
  run('git', ['fetch', '--prune', 'origin']);

  const baseOnOrigin =
    spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`], {
      stdio: 'ignore',
    }).status === 0;
  if (!baseOnOrigin) {
    fail(
      `Base branch '${baseBranch}' does not exist on origin.`,
      `Usage: ${PROG} sync [dest]   (default: ${defaultBase()})`
    );
  }

  // How many commits is the base ahead of us? If none, there's nothing to pull
  // in — say so and stop before touching the working tree.
  let behind = '0';
  try {
    behind = git(['rev-list', '--count', `HEAD..origin/${baseBranch}`]);
  } catch {}
  if (behind === '0') {
    console.log(`Already up to date with origin/${baseBranch}.`);
    return;
  }

  const plural = behind === '1' ? '' : 's';
  console.log(
    strategy === 'rebase'
      ? `==> Rebasing '${branch}' onto origin/${baseBranch} (${behind} new commit${plural})...`
      : `==> Merging origin/${baseBranch} into '${branch}' (${behind} new commit${plural})...`
  );

  const r = spawnSync('git', [strategy, `origin/${baseBranch}`], { stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') fail('git: command not found');
  if (r.status !== 0) {
    // Conflicts (or another failure) — leave the in-progress state in place and
    // tell the user how to finish or back out. Don't exit 0 on a broken tree.
    console.error('');
    if (strategy === 'rebase') {
      fail(
        'The rebase stopped on conflicts. Resolve them, then continue with:',
        '  git add <files> && git rebase --continue',
        'Or back out and return to where you were:',
        '  git rebase --abort'
      );
    }
    fail(
      'The merge stopped on conflicts. Resolve them, then commit with:',
      '  git add <files> && git commit',
      'Or back out and return to where you were:',
      '  git merge --abort'
    );
  }

  console.log('');
  console.log(`Synced '${branch}' with origin/${baseBranch}.`);

  // If the branch is already published, its PR needs updating. A rebase rewrote
  // history, so origin can't fast-forward — that needs a lease-guarded force
  // push. A merge only adds a commit, so a normal `ship` push is enough.
  const onOrigin =
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    }).status === 0;
  if (onOrigin) {
    if (strategy === 'rebase') {
      console.log('History changed by the rebase — update the open PR with a force push:');
      console.log(`  git push --force-with-lease origin ${branch}`);
    } else {
      console.log(`Push the merge to update the open PR with: ${PROG} ship`);
    }
  }
}

// Merge the current feature's open PR with gh, then clean up like `done`.
function cmdMerge(strategy) {
  const repo = resolveRepo();
  const prefix = featurePrefix();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  if (repo.host !== 'github') {
    fail(
      `'${PROG} merge' uses the GitHub CLI, and this origin is ${repo.host}.`,
      `Merge the PR in the browser instead, then run: ${PROG} done`
    );
  }
  if (!ghUsable(repo)) {
    fail(
      'GitHub CLI (gh) not found or not logged in.',
      'Install it from https://cli.github.com then run: gh auth login',
      `Or merge the PR in the browser and run: ${PROG} done`
    );
  }
  if (!branch.startsWith(prefix)) {
    // Not a feature branch — merge its PR anyway (matches `ship`). `done`
    // cleanup below skips the local branch delete for non-feature branches.
    console.log(`Note: '${branch}' is not a git-flow feature branch (${prefix}*) — merging its PR anyway.`);
  }
  if (git(['status', '--porcelain']) !== '') {
    fail('You have uncommitted changes. Commit or stash them before merging.');
  }

  console.log('==> git fetch --prune origin');
  run('git', ['fetch', '--prune', 'origin']);

  const onOrigin =
    spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
      stdio: 'ignore',
    }).status === 0;
  if (!onOrigin) {
    fail(`'${branch}' is not published to origin. Ship it first: ${PROG} ship`);
  }

  const unpushed = git(['rev-list', '--count', `origin/${branch}..HEAD`]);
  if (unpushed !== '0') {
    fail(
      `You have ${unpushed} commit(s) on '${branch}' that are not pushed.`,
      `Run '${PROG} ship' first so the PR is up to date.`
    );
  }

  const pr = ghJson(['pr', 'view', branch, '--json', 'number,url,state,baseRefName,isDraft']);
  if (!pr || pr.state !== 'OPEN') {
    fail(`No open PR found for '${branch}'. Create one first: ${PROG} ship`);
  }
  if (pr.isDraft) {
    fail(
      `PR #${pr.number} is still a draft. Mark it ready first:`,
      `  gh pr ready ${pr.number}`
    );
  }

  console.log(`==> Merging PR #${pr.number} (${strategy.slice(2)}): ${branch} -> ${pr.baseRefName}`);
  run('gh', ['pr', 'merge', String(pr.number), strategy]);

  console.log('');
  cmdDone(pr.baseRefName);
}

function cmdDone(dest) {
  const prefix = featurePrefix();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = dest || branchBase(branch) || defaultBase();

  if (git(['status', '--porcelain']) !== '') {
    fail('You have uncommitted changes. Commit or stash them before cleaning up.');
  }

  console.log(`==> git checkout ${baseBranch}`);
  run('git', ['checkout', baseBranch]);
  console.log(`==> git pull origin ${baseBranch}`);
  run('git', ['pull', 'origin', baseBranch]);

  if (branch.startsWith(prefix)) {
    // Warn instead of silently force-deleting work that never made it into
    // the base branch (e.g. `done` run before the PR was actually merged).
    const merged =
      spawnSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], {
        stdio: 'ignore',
      }).status === 0;
    if (!merged) {
      console.log(`    Note: '${branch}' is not merged into ${baseBranch} as a regular merge`);
      console.log('    (fine if the PR was squash-merged — deleting anyway).');
    }
    console.log(`==> git branch -D ${branch}`);
    run('git', ['branch', '-D', branch]);
  } else {
    console.log(`    (was on '${branch}', not a ${prefix}* branch — nothing to delete)`);
  }

  console.log('==> git fetch --prune origin');
  run('git', ['fetch', '--prune', 'origin']);

  console.log('');
  console.log(`All cleaned up. Start the next one with: ${PROG} start <name>`);
}

function cmdStatus() {
  const prefix = featurePrefix();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const isFeature = branch.startsWith(prefix);
  const dirty = git(['status', '--porcelain']) !== '';
  const base = branchBase(branch) || defaultBase();

  console.log(`Branch:     ${branch}${isFeature ? '' : `  (not a ${prefix}* branch)`}`);
  if (base !== defaultBase()) {
    console.log(`Base:       ${base} (recorded by '${PROG} start')`);
  }
  console.log(`Changes:    ${dirty ? 'uncommitted changes present' : 'clean'}`);

  const onOrigin =
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    }).status === 0;
  console.log(`Published:  ${onOrigin ? `yes (origin/${branch})` : 'no'}`);

  if (onOrigin) {
    try {
      const unpushed = git(['rev-list', '--count', `origin/${branch}..HEAD`]);
      if (unpushed !== '0') console.log(`Unpushed:   ${unpushed} commit(s) not on origin/${branch}`);
    } catch {}
  }

  try {
    // Counts are against the last-fetched origin/<base> ref.
    const counts = git(['rev-list', '--left-right', '--count', `origin/${base}...HEAD`]);
    const [behind, ahead] = counts.split(/\s+/);
    console.log(`vs ${base}: ${ahead} ahead, ${behind} behind origin/${base} (as of last fetch)`);
  } catch {
    console.log(`vs ${base}: unknown (no origin/${base} ref — fetch first)`);
  }

  if (isFeature) {
    const repo = resolveRepo();
    const pr = ghUsable(repo)
      ? ghJson(['pr', 'view', branch, '--json', 'number,url,state,isDraft,reviewDecision,mergeStateStatus'])
      : null;
    if (pr) {
      const bits = [pr.isDraft ? 'draft' : pr.state.toLowerCase()];
      if (pr.reviewDecision) bits.push(`review: ${pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}`);
      if (pr.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN') {
        bits.push(`merge: ${pr.mergeStateStatus.toLowerCase()}`);
      }
      console.log(`PR:         #${pr.number} (${bits.join(', ')})`);
      console.log(`            ${pr.url}`);
    } else if (ghUsable(repo)) {
      console.log(`PR:         none yet — create one with: ${PROG} ship`);
    } else {
      console.log(`PR page:    ${buildPrUrl(repo, branch, base)}`);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = rest.filter((a) => a.startsWith('--'));
  const pos = rest.filter((a) => !a.startsWith('--'));

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage(0);
  }

  switch (cmd) {
    case 'start':
      cmdStart(pos[0], pos[1]);
      break;
    case 'ship': {
      for (const f of flags) {
        if (f !== '--draft' && f !== '--web') fail(`Unknown flag for ship: ${f}`);
      }
      await cmdShip(pos[0], {
        draft: flags.includes('--draft'),
        web: flags.includes('--web'),
      });
      break;
    }
    case 'sync': {
      const known = ['--merge', '--rebase'];
      for (const f of flags) {
        if (!known.includes(f)) fail(`Unknown flag for sync: ${f}`);
      }
      if (flags.includes('--merge') && flags.includes('--rebase')) {
        fail('Pick one of --merge, --rebase.');
      }
      cmdSync(pos[0], { merge: flags.includes('--merge') });
      break;
    }
    case 'merge': {
      const strategies = ['--merge', '--squash', '--rebase'];
      const chosen = [];
      for (const f of flags) {
        if (!strategies.includes(f)) fail(`Unknown flag for merge: ${f}`);
        if (!chosen.includes(f)) chosen.push(f);
      }
      if (chosen.length > 1) fail('Pick one of --merge, --squash, --rebase.');
      cmdMerge(chosen[0] || '--merge');
      break;
    }
    case 'done':
      cmdDone(pos[0]);
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      usage();
  }
}

if (require.main === module) {
  main().catch((err) => {
    fail(err && err.message ? err.message : String(err));
  });
}

// Exported for tests; the CLI entry point is the guarded main() above.
module.exports = { prTitleBody, prTemplate, defaultBase, gitflowInitialized, publishPlan };
