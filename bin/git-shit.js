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
//   - `git-shit list` is a dashboard of every feature/* branch and its live PR
//     state; `git-shit completion <bash|zsh|fish>` prints a completion script.

'use strict';

const { execFileSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_BRANCH = 'staging';
const PROG = 'git-shit';
const { version: VERSION } = require('../package.json');

// Subcommands and their flags — the single source the shell-completion scripts
// are generated from, so completions never drift from what the CLI accepts.
const COMMANDS = [
  { name: 'start', desc: 'Start a new git-flow feature' },
  { name: 'ship', desc: 'Push the branch and open a PR' },
  { name: 'sync', desc: 'Catch the branch up to its base' },
  { name: 'merge', desc: 'Merge the open PR, then clean up' },
  { name: 'done', desc: 'Clean up after the PR is merged' },
  { name: 'status', desc: 'Show branch, publish, and PR state' },
  { name: 'list', desc: 'List feature branches and their PRs' },
  { name: 'completion', desc: 'Print a shell-completion script' },
  { name: 'help', desc: 'Show help' },
  { name: 'version', desc: 'Show the version' },
];
const FLAGS = {
  start: ['--on='],
  ship: ['--draft', '--web', '--reviewer=', '--label=', '--assignee='],
  sync: ['--merge', '--rebase'],
  merge: ['--merge', '--squash', '--rebase', '--when-green'],
  list: ['--plain'],
};

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

// Split a comma-separated (or comma+space) value into trimmed, non-empty items.
function splitList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// De-duplicate a list, preserving first-seen order.
function uniq(items) {
  return items.filter((v, i) => items.indexOf(v) === i);
}

// A multi-valued git config read (comma-separated), e.g. gitshit.reviewers.
function configList(key) {
  try {
    return splitList(git(['config', key]));
  } catch {
    return [];
  }
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

// Does a local branch with this exact name exist?
function localBranchExists(branch) {
  return (
    spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: 'ignore',
    }).status === 0
  );
}

// Is this branch published to origin right now? (one server round-trip)
function originHasBranch(branch) {
  return (
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    }).status === 0
  );
}

// A base is a *stack parent* (rather than a long-lived integration branch like
// staging/main) when it's itself a feature branch. Shipping onto it makes a
// stacked PR; when it merges its children get restacked onto its own base.
function isStackedBase(base, prefix) {
  return !!base && base.startsWith(prefix);
}

// Best-effort desktop notification, plus a terminal bell so it's noticed even
// headless. Used by `merge --when-green` when the wait resolves.
function notify(title, message) {
  process.stdout.write('\x07');
  try {
    if (process.platform === 'darwin' && commandExists('osascript')) {
      spawnSync(
        'osascript',
        ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
        { stdio: 'ignore' }
      );
    } else if (commandExists('notify-send')) {
      spawnSync('notify-send', [title, message], { stdio: 'ignore' });
    }
  } catch {}
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

// --- async runners + spinner ------------------------------------------------
// The network calls (`gh pr list/view`, `git ls-remote`) are the slow part of
// list/status/merge. Running them async (instead of spawnSync) lets a spinner
// animate while they're in flight, and lets independent ones run in parallel.

// Run a command and capture stdout/stderr without blocking the event loop.
function spawnCapture(cmd, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ status: null, stdout, stderr, error });
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Async ghJson: parse gh's JSON output, null on any failure.
async function ghJsonAsync(args) {
  const r = await spawnCapture('gh', args);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// A tiny spinner on stderr (so it never pollutes captured/piped stdout). On a
// non-TTY it prints the label once; otherwise it animates until stopped.
function startSpinner(label) {
  if (!process.stderr.isTTY) {
    if (label) process.stderr.write(`${label}...\n`);
    return { stop() {} };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const draw = () => process.stderr.write(`\r\x1b[K${frames[i = (i + 1) % frames.length]} ${label}`);
  process.stderr.write('\x1b[?25l'); // hide cursor
  draw();
  const timer = setInterval(draw, 80);
  return {
    stop() {
      clearInterval(timer);
      process.stderr.write('\r\x1b[K\x1b[?25h'); // clear line, show cursor
    },
  };
}

// Run async work under a spinner, always clearing it (even on throw).
async function withSpinner(label, work) {
  const sp = startSpinner(label);
  try {
    return await work();
  } finally {
    sp.stop();
  }
}

function usage(exitCode = 1) {
  const base = defaultBase();
  console.log(`${PROG} ${VERSION}

Usage:
  ${PROG} start <name> [base] [--on=<parent>]
                         Start a new git-flow feature. With base, branch off
                         origin/<base> (e.g. production) instead of git-flow's
                         develop, and make <base> the default PR target for
                         this branch. With --on=<parent>, stack it on another
                         feature branch: its PR targets <parent>, and when
                         <parent> merges this branch is restacked automatically.
  ${PROG} ship [dest] [--draft] [--web]
       [--reviewer=a,b] [--label=x] [--assignee=@me]
                         Push current feature and open a PR against dest
                         (default: the branch's recorded base, else ${base}).
                         On GitHub with the gh CLI the
                         PR is created from the terminal (--draft for a draft
                         PR, --web to force the browser flow). Bitbucket or no
                         gh: opens the PR page in Chrome and auto-clicks Create.
                         Reviewers/labels/assignees also come from git config
                         (gitshit.reviewers/labels/assignees).
  ${PROG} sync [dest] [--merge]
                         Catch the current branch up to its base: fetch, then
                         rebase (or --merge) origin/<base> into it (default:
                         the branch's recorded base, else ${base}).
  ${PROG} merge [--merge|--squash|--rebase] [--when-green]
                         Merge the feature's open PR with gh (GitHub only,
                         default: --merge), then clean up like 'done'.
                         --when-green waits for checks to pass first and
                         notifies you when it merges (or a check fails).
  ${PROG} done [dest]    After the PR is merged: checkout dest (default: the
                         branch's recorded base, else ${base}), pull, delete
                         the local feature branch, prune stale refs, and
                         restack any branches that were stacked on it.
  ${PROG} status         Show branch, publish state, PR state, and commits
                         vs the branch's base
  ${PROG} list [--plain] Dashboard of every ${featurePrefix()}* branch: base,
                         publish state, and live PR/checks/review state. In a
                         terminal it's an interactive board (↑/↓, o/c/s/m/r/q);
                         --plain (or piping) prints the static table.
  ${PROG} completion <bash|zsh|fish>
                         Print a shell-completion script for the given shell
  ${PROG} help           Show this help    (also --help, -h)
  ${PROG} version        Show the version  (also --version, -v)

The default PR target is '${base}'. Change it with:
  git config gitshit.base <branch>       (add --global to set it everywhere)`);
  process.exit(exitCode);
}

// Parse workspace/repo from an origin remote URL; null if it isn't a
// recognised bitbucket/github URL. Handles:
//   git@bitbucket.org:workspace/repo.git
//   https://user@bitbucket.org/workspace/repo.git
//   git@github.com:owner/repo.git
//   https://github.com/owner/repo.git
function parseRepo(remoteUrl) {
  const m = (remoteUrl || '').match(/(bitbucket\.org|github\.com)[:/]([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const host = m[1] === 'github.com' ? 'github' : 'bitbucket';
  const workspace = m[2];
  const repoSlug = m[3].replace(/\.git$/, '');
  return { host, web: `https://${m[1]}/${workspace}/${repoSlug}` };
}

// The origin remote as {host, web}; exits with guidance if it can't be parsed.
// `list` uses parseRepo directly so it can degrade instead of aborting.
function resolveRepo() {
  let remoteUrl = '';
  try {
    remoteUrl = git(['remote', 'get-url', 'origin']);
  } catch {}
  const repo = parseRepo(remoteUrl);
  if (!repo) {
    fail(
      'Could not determine workspace/repo from the origin remote',
      '(expected a bitbucket.org or github.com URL):',
      `  ${remoteUrl || '<no origin remote found>'}`
    );
  }
  return repo;
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

// Resolve a `--on=<parent>` value to a local branch name. Accepts either the
// short feature name ('feat-a') or the full branch ('feature/feat-a').
function resolveParent(on, prefix) {
  const candidates = on.startsWith(prefix) ? [on] : [`${prefix}${on}`, on];
  for (const c of candidates) if (localBranchExists(c)) return c;
  return null;
}

function cmdStart(name, base, opts = {}) {
  if (!name) fail(`Usage: ${PROG} start <name> [base] [--on=<parent>]`);
  const prefix = featurePrefix();
  const branch = `${prefix}${name}`;

  if (opts.on && base) {
    fail(
      'Pass either a base or --on=<parent>, not both.',
      '  base        branches off origin/<base> (a long-lived branch)',
      '  --on=parent stacks this branch on another feature branch'
    );
  }

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
  //
  // recordedBase is what gets stored as this branch's default PR target. With
  // --on=<parent> it's the parent feature branch (a stacked PR); with a plain
  // base argument it's that base branch.
  let baseRef = '';
  let recordedBase = '';
  if (opts.on) {
    // Stacked: branch off the tip of a local parent feature branch. The parent
    // need not be on origin yet — it just has to be shipped before this child.
    const parent = resolveParent(opts.on, prefix);
    if (!parent) {
      fail(
        `Parent branch for --on=${opts.on} not found locally.`,
        `Create or check out the parent first, e.g. ${PROG} start ${opts.on}.`
      );
    }
    if (parent === branch) fail('A branch cannot be stacked on itself.');
    baseRef = parent;
    recordedBase = parent;
  } else if (base) {
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

  if (recordedBase) {
    // Branching off another ref makes git track it as upstream — drop that so
    // `git pull` / the Published check don't point at the base branch.
    // (`git flow feature publish` sets the real upstream later.)
    spawnSync('git', ['branch', '--unset-upstream', branch], { stdio: 'ignore' });
    // Remember the base: ship/sync/done/status default to it for this branch.
    run('git', ['config', `branch.${branch}.gitshitbase`, recordedBase]);
  }

  console.log('');
  console.log(`Feature branch '${branch}' created${baseRef ? ` from ${baseRef}` : ''}.`);
  if (opts.on) {
    console.log(`Stacked on '${recordedBase}' — its PR will target that branch.`);
    console.log(`Ship '${recordedBase}' first, then ${PROG} ship this one.`);
  } else if (recordedBase) {
    console.log(`PRs from this branch will target '${recordedBase}' by default.`);
  }
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

// Build the `gh pr create` argument list. Reviewers/labels/assignees are each
// passed as repeated flags (gh accepts one value per flag).
function prCreateArgs({ base, head, title, body, draft, reviewers = [], labels = [], assignees = [] }) {
  const args = [
    'pr', 'create',
    '--base', base,
    '--head', head,
    '--title', title || head,
    '--body', body || '',
  ];
  if (draft) args.push('--draft');
  for (const r of reviewers) args.push('--reviewer', r);
  for (const l of labels) args.push('--label', l);
  for (const a of assignees) args.push('--assignee', a);
  return args;
}

// Reviewers/labels/assignees for a new PR: git-config defaults unioned with any
// --reviewer=/--label=/--assignee= flags passed to `ship`.
function prPeople(opts) {
  return {
    reviewers: uniq([...configList('gitshit.reviewers'), ...(opts.reviewers || [])]),
    labels: uniq([...configList('gitshit.labels'), ...(opts.labels || [])]),
    assignees: uniq([...configList('gitshit.assignees'), ...(opts.assignees || [])]),
  };
}

// Create the PR with `gh pr create` (or recognise the one already open).
async function shipViaGh(branch, baseBranch, opts = {}) {
  const existing = await withSpinner('Checking for an existing PR', () =>
    ghJsonAsync(['pr', 'view', branch, '--json', 'number,url,state,isDraft'])
  );
  if (existing && existing.state === 'OPEN') {
    console.log(
      `==> PR #${existing.number}${existing.isDraft ? ' (draft)' : ''} already open — it now has your latest commits.`
    );
    console.log(`    ${existing.url}`);
  } else {
    const { title, body } = prTitleBody(baseBranch, branch);
    const { reviewers, labels, assignees } = prPeople(opts);

    console.log(`==> Creating PR via gh: ${branch} -> ${baseBranch}${opts.draft ? ' (draft)' : ''}`);
    if (reviewers.length) console.log(`    reviewers: ${reviewers.join(', ')}`);
    if (labels.length) console.log(`    labels: ${labels.join(', ')}`);
    if (assignees.length) console.log(`    assignees: ${assignees.join(', ')}`);
    run('gh', prCreateArgs({
      base: baseBranch,
      head: branch,
      title: title || branch,
      body,
      draft: opts.draft,
      reviewers,
      labels,
      assignees,
    }));
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
  if (!useGh && ((opts.reviewers || []).length || (opts.labels || []).length || (opts.assignees || []).length)) {
    console.log('Note: --reviewer/--label/--assignee need the gh CLI (GitHub) — ignored in the browser flow.');
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = dest || branchBase(branch) || defaultBase();
  const isFeature = branch.startsWith(prefix);
  // Stacked: the PR targets another feature branch (its parent) rather than a
  // long-lived base. The parent has to be shipped first so origin has it.
  const stacked = isStackedBase(baseBranch, prefix) && baseBranch !== branch;

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

  if (stacked) {
    console.log(`Note: stacked PR — '${branch}' targets its parent '${baseBranch}'.`);
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
    if (stacked) {
      fail(
        `Parent branch '${baseBranch}' isn't on origin yet — a stacked PR needs it first.`,
        `Ship the parent, then this one:`,
        `  git checkout ${baseBranch} && ${PROG} ship`,
        `  git checkout ${branch} && ${PROG} ship`
      );
    }
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
    await shipViaGh(branch, baseBranch, opts);
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

// Poll a PR's checks until they're all green (or one fails), returning
// 'green' | 'merged' when it's OK to proceed. Fails the process on a failing
// check or timeout. A PR with no checks at all counts as green immediately.
async function waitForGreen(branch) {
  const intervalMs = 20_000;
  const deadline = Date.now() + 60 * 60 * 1000; // give up after an hour
  console.log('==> Waiting for checks to pass (polling every 20s — Ctrl-C to stop)...');
  for (;;) {
    const pr = ghJson(['pr', 'view', branch, '--json', 'number,state,isDraft,statusCheckRollup,reviewDecision']);
    if (!pr) fail(`Can't read the PR for '${branch}' any more — did it get closed?`);
    if (pr.state === 'MERGED') {
      console.log(`PR #${pr.number} was merged elsewhere.`);
      return 'merged';
    }
    if (pr.state !== 'OPEN') fail(`PR #${pr.number} is ${String(pr.state).toLowerCase()} — stopping.`);

    const t = tallyChecks(pr.statusCheckRollup);
    if (t.fail > 0) {
      notify('git-shit: checks failed', `${branch}: ${t.fail} check(s) failing`);
      fail(
        `${t.fail} check(s) failing on PR #${pr.number} — not merging.`,
        `See what broke: gh pr checks ${pr.number}`
      );
    }
    if (t.total === 0 || t.pending === 0) {
      console.log(`==> Checks green${t.total ? ` (${t.pass}/${t.total})` : ' (none configured)'}.`);
      return 'green';
    }
    if (Date.now() > deadline) {
      notify('git-shit: still waiting', `${branch}: checks not finished after 1h`);
      fail(`Gave up after 1h — ${t.pending} check(s) on PR #${pr.number} still pending.`);
    }
    const rev = pr.reviewDecision ? `, review ${pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : '';
    console.log(`    ${t.pass}/${t.total} passed, ${t.pending} pending${rev} — retrying in 20s`);
    await sleep(intervalMs);
  }
}

// Merge the current feature's open PR with gh, then clean up like `done`.
// With opts.whenGreen, wait for checks to pass first, then notify on merge.
async function cmdMerge(strategy, opts = {}) {
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

  const pr = await withSpinner('Looking up the open PR', () =>
    ghJsonAsync(['pr', 'view', branch, '--json', 'number,url,state,baseRefName,isDraft'])
  );
  if (!pr || pr.state !== 'OPEN') {
    fail(`No open PR found for '${branch}'. Create one first: ${PROG} ship`);
  }
  if (pr.isDraft) {
    fail(
      `PR #${pr.number} is still a draft. Mark it ready first:`,
      `  gh pr ready ${pr.number}`
    );
  }

  if (opts.whenGreen) {
    const state = await waitForGreen(branch);
    if (state === 'merged') {
      // Someone merged it while we waited — just clean up locally.
      console.log('');
      cmdDone(pr.baseRefName);
      notify('git-shit: cleaned up', `${branch} was already merged`);
      return;
    }
  }

  console.log(`==> Merging PR #${pr.number} (${strategy.slice(2)}): ${branch} -> ${pr.baseRefName}`);
  run('gh', ['pr', 'merge', String(pr.number), strategy]);
  notify('git-shit: PR merged', `#${pr.number} ${branch} -> ${pr.baseRefName}`);

  console.log('');
  cmdDone(pr.baseRefName);
}

function safeRemoteUrl() {
  try {
    return git(['remote', 'get-url', 'origin']);
  } catch {
    return '';
  }
}

// Local feature branches stacked directly on `parent` — their recorded base is
// exactly `parent` (read from `branch.<name>.gitshitbase`).
function childrenOf(parent) {
  let out = '';
  try {
    out = git(['config', '--get-regexp', '^branch\\..*\\.gitshitbase$']);
  } catch {
    return [];
  }
  const kids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^branch\.(.+)\.gitshitbase (.+)$/);
    if (m && m[2] === parent && m[1] !== parent && localBranchExists(m[1])) kids.push(m[1]);
  }
  return kids;
}

// After `parent` merges into `newBase`, its direct children still branch off
// the (now-merged, about-to-vanish) parent. Rebase each onto `newBase`, drop
// the parent's now-redundant commits (git rebase --onto uses the parent's old
// tip as the upstream), retarget its recorded base + open PR, and force-push.
// Deeper descendants keep their own recorded base — a note points to sync.
function restackChildren(parent, newBase, oldTip) {
  const kids = childrenOf(parent);
  if (!kids.length) return;

  console.log('');
  console.log(`==> Restacking ${kids.length} branch(es) stacked on '${parent}' onto '${newBase}'...`);

  const repo = parseRepo(safeRemoteUrl());
  const gh = repo && ghUsable(repo);

  for (const child of kids) {
    console.log(`==> ${child}: rebasing onto ${newBase}`);
    const r = spawnSync('git', ['rebase', '--onto', newBase, oldTip, child], { stdio: 'inherit' });
    if (r.status !== 0) {
      spawnSync('git', ['rebase', '--abort'], { stdio: 'ignore' });
      console.log(`    Couldn't auto-restack '${child}' (conflicts). Finish it by hand:`);
      console.log(`      git rebase --onto ${newBase} ${oldTip} ${child}`);
      console.log(`      git config branch.${child}.gitshitbase ${newBase}`);
      console.log(`      git push --force-with-lease origin ${child}   # if published`);
      continue;
    }
    // The rebase left us on `child`. Record the new base, retarget the PR, push.
    run('git', ['config', `branch.${child}.gitshitbase`, newBase]);
    if (originHasBranch(child)) {
      if (gh) {
        const pr = ghJson(['pr', 'view', child, '--json', 'number,state']);
        if (pr && pr.state === 'OPEN') {
          console.log(`    retargeting PR #${pr.number} base -> ${newBase}`);
          spawnSync('gh', ['pr', 'edit', String(pr.number), '--base', newBase], { stdio: 'inherit' });
        }
      }
      console.log(`    git push --force-with-lease origin ${child}`);
      const push = spawnSync('git', ['push', '--force-with-lease', 'origin', child], { stdio: 'inherit' });
      if (push.status !== 0) {
        // The merge already landed — don't abort the rest of the restack over a
        // stale lease; just tell the user to push the rebased child by hand.
        console.log(`    Couldn't push '${child}' — run: git push --force-with-lease origin ${child}`);
      }
    }
    console.log(`    '${child}' now stacked on '${newBase}'.`);
  }

  // Rebases left us on the last child — land back on the base for a clean end.
  spawnSync('git', ['checkout', newBase], { stdio: 'ignore' });
}

function cmdDone(dest) {
  const prefix = featurePrefix();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = dest || branchBase(branch) || defaultBase();

  if (git(['status', '--porcelain']) !== '') {
    fail('You have uncommitted changes. Commit or stash them before cleaning up.');
  }

  // Capture the merged branch's tip before it's deleted — restackChildren needs
  // it as the rebase upstream so children shed exactly the parent's commits.
  let oldTip = '';
  try {
    oldTip = git(['rev-parse', branch]);
  } catch {}

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

  // Restack any branches that were stacked on the branch we just merged so they
  // now target its base instead of a branch that's about to disappear.
  if (oldTip) restackChildren(branch, baseBranch, oldTip);

  console.log('');
  console.log(`All cleaned up. Start the next one with: ${PROG} start <name>`);
}

async function cmdStatus() {
  const prefix = featurePrefix();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const isFeature = branch.startsWith(prefix);
  const dirty = git(['status', '--porcelain']) !== '';
  const base = branchBase(branch) || defaultBase();

  console.log(`Branch:     ${branch}${isFeature ? '' : `  (not a ${prefix}* branch)`}`);
  if (base !== defaultBase()) {
    const note = isStackedBase(base, prefix) ? 'stacked parent' : `recorded by '${PROG} start'`;
    console.log(`Base:       ${base} (${note})`);
  }
  console.log(`Changes:    ${dirty ? 'uncommitted changes present' : 'clean'}`);

  // The two network calls — is the branch published, and its live PR — are
  // independent, so fetch them together under one spinner instead of blocking
  // silently one after the other.
  const repo = isFeature ? resolveRepo() : null;
  const gh = isFeature && repo && ghUsable(repo);
  const [onOrigin, pr] = await withSpinner('Checking origin and PR state', async () => {
    const [ls, prJson] = await Promise.all([
      spawnCapture('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch]),
      gh
        ? ghJsonAsync(['pr', 'view', branch, '--json', 'number,url,state,isDraft,reviewDecision,mergeStateStatus'])
        : Promise.resolve(null),
    ]);
    return [ls.status === 0, prJson];
  });

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
    if (pr) {
      const bits = [pr.isDraft ? 'draft' : pr.state.toLowerCase()];
      if (pr.reviewDecision) bits.push(`review: ${pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}`);
      if (pr.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN') {
        bits.push(`merge: ${pr.mergeStateStatus.toLowerCase()}`);
      }
      console.log(`PR:         #${pr.number} (${bits.join(', ')})`);
      console.log(`            ${pr.url}`);
    } else if (gh) {
      console.log(`PR:         none yet — create one with: ${PROG} ship`);
    } else {
      console.log(`PR page:    ${buildPrUrl(repo, branch, base)}`);
    }
  }
}

// --- list: a dashboard of every feature branch ------------------------------
// Pure formatting helpers (below) are unit-tested; cmdList only gathers the
// live data (branches, origin heads, open PRs) and hands it to them.

// Tally a PR's statusCheckRollup into {pass, fail, pending, total}. A check is a
// CheckRun (has .conclusion once finished, else .status) or a StatusContext
// (.state). The single source of truth for both the `list` summary and the
// `merge --when-green` wait loop.
function tallyChecks(rollup) {
  const t = { pass: 0, fail: 0, pending: 0, total: 0 };
  if (!Array.isArray(rollup)) return t;
  for (const c of rollup) {
    t.total++;
    const s = String(c.conclusion || c.state || '').toUpperCase();
    if (s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED') t.pass++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) t.fail++;
    else t.pending++;
  }
  return t;
}

// One-line summary of a PR's check runs, or '' if there are none.
function checksSummary(rollup) {
  const t = tallyChecks(rollup);
  if (t.total === 0) return '';
  if (t.fail) return `checks: ${t.fail} failing`;
  if (t.pending) return `checks: ${t.pass}/${t.total}`;
  return 'checks: ok';
}

// Short label for gh's reviewDecision, or '' when there's no decision yet.
function reviewSummary(decision) {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes requested';
    case 'REVIEW_REQUIRED':
      return 'review pending';
    default:
      return '';
  }
}

// The PR column for one branch: '#12 open · checks: 2/3 · review pending', or
// 'no PR' / '—' when gh is available and there's none, or '' when we can't tell
// (Bitbucket, or gh not logged in).
function prCellText(pr, published, ghAvailable) {
  if (pr) {
    const bits = [`#${pr.number}`, pr.isDraft ? 'draft' : String(pr.state).toLowerCase()];
    const checks = checksSummary(pr.statusCheckRollup);
    if (checks) bits.push(checks);
    const review = reviewSummary(pr.reviewDecision);
    if (review) bits.push(review);
    return bits.join(' · ');
  }
  if (!ghAvailable) return '';
  return published ? 'no PR' : '—';
}

// The effective base of a branch for display: a live PR's real target wins,
// else the branch's recorded/default base (what `ship` would target).
function effectiveBaseOf(b, prByBranch, baseOf) {
  const pr = prByBranch[b];
  return (pr && pr.baseRefName) || baseOf(b);
}

// How deep in a stack a branch sits: 0 for a branch whose base is a long-lived
// branch, 1 for one stacked on another branch in the set, and so on.
function stackDepth(b, branchSet, effBaseOf) {
  let d = 0;
  let cur = b;
  const seen = new Set([b]);
  while (d < 50) {
    const base = effBaseOf(cur);
    if (!branchSet.has(base) || seen.has(base)) break;
    seen.add(base);
    cur = base;
    d++;
  }
  return d;
}

// Reorder feature branches so each stacked child follows its parent
// (depth-first), preserving the input order among roots and siblings.
function stackOrder(branches, effBaseOf) {
  const inSet = new Set(branches);
  const kids = new Map();
  const roots = [];
  for (const b of branches) {
    const base = effBaseOf(b);
    if (inSet.has(base) && base !== b) {
      if (!kids.has(base)) kids.set(base, []);
      kids.get(base).push(b);
    } else {
      roots.push(b);
    }
  }
  const ordered = [];
  const seen = new Set();
  const visit = (b) => {
    if (seen.has(b)) return;
    seen.add(b);
    ordered.push(b);
    for (const k of kids.get(b) || []) visit(k);
  };
  for (const r of roots) visit(r);
  for (const b of branches) if (!seen.has(b)) { seen.add(b); ordered.push(b); } // orphans/cycles
  return ordered;
}

// Turn the gathered primitives into display rows (one per branch). When a PR
// exists its real target wins the BASE column; otherwise it's the branch's
// recorded/default base (what `ship` would target). `depth` marks stacking.
function buildListRows({ branches, current, remoteHeads, prByBranch, baseOf, ghAvailable }) {
  const branchSet = new Set(branches);
  const effBaseOf = (b) => effectiveBaseOf(b, prByBranch, baseOf);
  return branches.map((b) => {
    const published = remoteHeads.has(b);
    const pr = prByBranch[b];
    return {
      mark: b === current ? '*' : ' ',
      branch: b,
      depth: stackDepth(b, branchSet, effBaseOf),
      base: (pr && pr.baseRefName) || baseOf(b),
      state: published ? 'published' : 'local only',
      pr: prCellText(pr, published, ghAvailable),
    };
  });
}

// Branch column as displayed, indented with a tree glyph for stacked children.
function branchLabel(row) {
  return (row.depth > 0 ? '  '.repeat(row.depth - 1) + '└─ ' : '') + row.branch;
}

// Render rows as an aligned table (header + one line per row).
function renderList(rows) {
  const width = (get, head) => Math.max(head.length, ...rows.map((r) => get(r).length));
  const bw = width(branchLabel, 'BRANCH');
  const baw = width((r) => r.base, 'BASE');
  const sw = width((r) => r.state, 'STATE');
  const lines = [`  ${'BRANCH'.padEnd(bw)}  ${'BASE'.padEnd(baw)}  ${'STATE'.padEnd(sw)}  PR`];
  for (const r of rows) {
    lines.push(`${r.mark} ${branchLabel(r).padEnd(bw)}  ${r.base.padEnd(baw)}  ${r.state.padEnd(sw)}  ${r.pr}`.trimEnd());
  }
  return lines;
}

// Gather everything the dashboard needs in the fewest round-trips: local feature
// branches (most-recently-committed first), the set of published heads (one
// ls-remote), and every PR keyed by head branch (one gh call).
async function gatherListData(opts = {}) {
  const prefix = featurePrefix();
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  const branches = git([
    'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', `refs/heads/${prefix}`,
  ])
    .split('\n')
    .filter(Boolean);

  const remoteHeads = new Set();
  const prByBranch = {};
  const repo = parseRepo(safeRemoteUrl());
  const ghAvailable = !!(repo && ghUsable(repo));

  if (!branches.length) return { prefix, current, branches, remoteHeads, prByBranch, repo, ghAvailable };

  // Published state (ls-remote) and PR state (gh pr list) are independent — run
  // them together under one spinner so the wait is the slower of the two, not
  // their sum. `opts.quiet` skips the spinner (used by the board's redraw).
  const spin = opts.quiet ? (l, w) => w() : withSpinner;
  await spin(ghAvailable ? 'Loading branches and pull requests' : 'Loading branches', async () => {
    const [ls, prs] = await Promise.all([
      spawnCapture('git', ['ls-remote', '--heads', 'origin']),
      ghAvailable
        ? ghJsonAsync([
            'pr', 'list', '--state', 'all', '--limit', '200',
            '--json', 'number,headRefName,baseRefName,state,isDraft,reviewDecision,statusCheckRollup,url',
          ])
        : Promise.resolve(null),
    ]);
    if (ls.status === 0) {
      for (const line of (ls.stdout || '').split('\n')) {
        const m = line.match(/\trefs\/heads\/(.+)$/);
        if (m) remoteHeads.add(m[1]);
      }
    }
    if (Array.isArray(prs)) {
      for (const pr of prs) {
        if (!(pr.headRefName in prByBranch)) prByBranch[pr.headRefName] = pr;
      }
    }
  });

  return { prefix, current, branches, remoteHeads, prByBranch, repo, ghAvailable };
}

// Stack-ordered display rows for the gathered data (shared by table + board).
function orderedRows(data) {
  const baseOf = (b) => branchBase(b) || defaultBase();
  const effBaseOf = (b) => effectiveBaseOf(b, data.prByBranch, baseOf);
  return buildListRows({
    branches: stackOrder(data.branches, effBaseOf),
    current: data.current,
    remoteHeads: data.remoteHeads,
    prByBranch: data.prByBranch,
    baseOf,
    ghAvailable: data.ghAvailable,
  });
}

function renderStaticList(data) {
  for (const line of renderList(orderedRows(data))) console.log(line);
  if (!data.ghAvailable) {
    console.log('');
    console.log('(PR/checks columns need the gh CLI on a GitHub remote: https://cli.github.com)');
  }
}

async function cmdList(opts = {}) {
  const data = await gatherListData();
  if (!data.branches.length) {
    console.log(`No ${data.prefix}* branches yet. Start one with: ${PROG} start <name>`);
    return;
  }
  // Interactive cockpit when attached to a terminal; plain table when piped,
  // redirected, or asked for with --plain (keeps `list` scriptable).
  if (!opts.plain && process.stdout.isTTY && process.stdin.isTTY) {
    await runBoard(data);
    return;
  }
  renderStaticList(data);
}

// --- list: interactive board ------------------------------------------------
// A raw-mode, dependency-free cockpit: navigate the same rows the table shows
// and act on the selected branch (open / checkout / ship / merge / refresh).

const ANSI = {
  clear: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  reverse: '\x1b[7m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

// Attach the pr object + published flag onto each display row so key actions
// have what they need without re-deriving it.
function boardItems(data) {
  return orderedRows(data).map((r) => ({
    ...r,
    published: data.remoteHeads.has(r.branch),
    prObj: data.prByBranch[r.branch] || null,
  }));
}

// Resolve the next key press as a single string (raw mode delivers escape
// sequences like an arrow key in one chunk).
function readKey(stdin) {
  return new Promise((resolve) => {
    const onData = (d) => {
      stdin.removeListener('data', onData);
      resolve(d);
    };
    stdin.on('data', onData);
  });
}

function drawBoard(items, sel, data) {
  const { reverse, dim, bold, reset } = ANSI;
  const bw = Math.max('BRANCH'.length, ...items.map((it) => branchLabel(it).length));
  const baw = Math.max('BASE'.length, ...items.map((it) => it.base.length));
  const sw = Math.max('STATE'.length, ...items.map((it) => it.state.length));

  const out = [
    `${bold}git-shit${reset}  ${dim}${items.length} ${data.prefix}* branch(es)${reset}`,
    '',
    `  ${dim}${'BRANCH'.padEnd(bw)}  ${'BASE'.padEnd(baw)}  ${'STATE'.padEnd(sw)}  PR${reset}`,
  ];
  items.forEach((it, i) => {
    const line = `${it.mark} ${branchLabel(it).padEnd(bw)}  ${it.base.padEnd(baw)}  ${it.state.padEnd(sw)}  ${it.pr}`.trimEnd();
    out.push(i === sel ? `${reverse}${line}${reset}` : line);
  });
  out.push('');
  if (!data.ghAvailable) out.push(`${dim}(gh unavailable — ship/merge still work, PR columns don't)${reset}`);
  out.push(`${dim}↑/↓ move · o open · c checkout · s ship · m merge · r refresh · q quit${reset}`);
  process.stdout.write(ANSI.clear + out.join('\r\n') + '\r\n');
}

// Open the selected branch's PR (or its compare page when there's no PR yet).
function openBoardTarget(it, data) {
  if (it.prObj && it.prObj.url) return openUrl(it.prObj.url);
  if (data.repo) openUrl(buildPrUrl(data.repo, it.branch, it.base));
}

async function runBoard(initial) {
  let data = initial;
  let items = boardItems(data);
  let sel = Math.max(0, items.findIndex((it) => it.branch === data.current));

  const stdin = process.stdin;
  const restore = () => {
    try { if (stdin.isTTY) stdin.setRawMode(false); } catch {}
    stdin.pause();
    process.stdout.write(ANSI.showCursor);
  };
  // Safety net: restore the terminal even if a sub-action calls process.exit.
  process.on('exit', restore);

  const enterRaw = () => {
    stdin.resume();
    stdin.setEncoding('utf8');
    try { stdin.setRawMode(true); } catch {}
    process.stdout.write(ANSI.hideCursor);
  };
  const reload = async () => {
    // quiet: the board owns the screen, so the stderr spinner would fight it —
    // we show our own one-line hint instead.
    data = await gatherListData({ quiet: true });
    items = boardItems(data);
    if (sel >= items.length) sel = items.length - 1;
    if (sel < 0) sel = 0;
  };

  // Drop out of the board, run a (possibly async) action against the real
  // terminal, then wait for a key and re-enter the refreshed board.
  const suspend = async (fn) => {
    try { stdin.setRawMode(false); } catch {}
    stdin.pause();
    process.stdout.write(ANSI.showCursor + ANSI.clear);
    try {
      await fn();
    } catch (e) {
      console.error(e && e.message ? e.message : String(e));
    }
    process.stdout.write('\n(press any key to return)');
    stdin.resume();
    stdin.setEncoding('utf8');
    try { stdin.setRawMode(true); } catch {}
    await readKey(stdin);
    await reload();
    process.stdout.write(ANSI.hideCursor);
    drawBoard(items, sel, data);
  };
  const checkout = (branch) => {
    if (branch === data.current) return;
    console.log(`==> git checkout ${branch}`);
    run('git', ['checkout', branch]);
  };

  enterRaw();
  drawBoard(items, sel, data);
  try {
    for (;;) {
      const key = await readKey(stdin);
      const it = items[sel];
      if (key === 'q' || key === '\x03' || key === '\x1b') break;
      else if (key === 'j' || key === '\x1b[B') sel = Math.min(items.length - 1, sel + 1);
      else if (key === 'k' || key === '\x1b[A') sel = Math.max(0, sel - 1);
      else if (key === 'g') sel = 0;
      else if (key === 'G') sel = items.length - 1;
      else if (key === 'r') {
        process.stdout.write(`${ANSI.clear}Refreshing…`);
        await reload();
        drawBoard(items, sel, data);
        continue;
      }
      else if ((key === 'o' || key === '\r' || key === '\n') && it) { openBoardTarget(it, data); continue; }
      else if (key === 'c' && it) { await suspend(async () => checkout(it.branch)); continue; }
      else if (key === 's' && it) {
        await suspend(async () => {
          checkout(it.branch);
          await cmdShip(undefined, { draft: false, web: false, reviewers: [], labels: [], assignees: [] });
        });
        continue;
      } else if (key === 'm' && it) {
        await suspend(async () => {
          checkout(it.branch);
          await cmdMerge('--merge', {});
        });
        continue;
      } else continue; // ignore unknown keys without a redraw
      drawBoard(items, sel, data);
    }
  } finally {
    restore();
    process.removeListener('exit', restore);
  }
}

// --- completion: emit a shell-completion script -----------------------------

function completionBash() {
  const cmds = COMMANDS.map((c) => c.name).join(' ');
  const cases = Object.entries(FLAGS)
    .map(([cmd, fl]) => `    ${cmd}) COMPREPLY=( $(compgen -W "${fl.join(' ')}" -- "$cur") ); return;;`)
    .join('\n');
  return `# ${PROG} bash completion.
# Install: add to ~/.bashrc:  source <(${PROG} completion bash)
_git_shit() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${cmds}" -- "\$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
    completion) COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\$cur") ); return;;
  esac
}
complete -F _git_shit ${PROG}
`;
}

function completionZsh() {
  const describe = COMMANDS.map((c) => `    '${c.name}:${c.desc}'`).join('\n');
  const cases = Object.entries(FLAGS)
    .map(([cmd, fl]) => `    ${cmd}) _values 'flag' ${fl.map((f) => `'${f}'`).join(' ')};;`)
    .join('\n');
  return `#compdef ${PROG}
# ${PROG} zsh completion.
# Install: add to ~/.zshrc:  source <(${PROG} completion zsh)
_git-shit() {
  local -a cmds
  cmds=(
${describe}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
    return
  fi
  case \$words[2] in
${cases}
    completion) _values 'shell' 'bash' 'zsh' 'fish';;
  esac
}
compdef _git-shit ${PROG}
`;
}

function completionFish() {
  const sub = COMMANDS.map(
    (c) => `complete -c ${PROG} -n '__fish_use_subcommand' -a ${c.name} -d '${c.desc}'`
  ).join('\n');
  const flagLines = Object.entries(FLAGS)
    .flatMap(([cmd, fl]) =>
      fl.map((f) => {
        const name = f.replace(/^--/, '').replace(/=$/, '');
        return `complete -c ${PROG} -n '__fish_seen_subcommand_from ${cmd}' -l ${name}`;
      })
    )
    .join('\n');
  return `# ${PROG} fish completion.
# Install: ${PROG} completion fish > ~/.config/fish/completions/${PROG}.fish
complete -c ${PROG} -f
${sub}
${flagLines}
complete -c ${PROG} -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
`;
}

function cmdCompletion(shell) {
  const scripts = { bash: completionBash, zsh: completionZsh, fish: completionFish };
  const gen = scripts[shell];
  if (!gen) {
    fail(
      `Usage: ${PROG} completion <bash|zsh|fish>`,
      'Prints a completion script. Load it in your shell, e.g.:',
      `  source <(${PROG} completion bash)   # or zsh`,
      `  ${PROG} completion fish > ~/.config/fish/completions/${PROG}.fish`
    );
  }
  process.stdout.write(gen());
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
    case 'start': {
      const opts = {};
      for (const f of flags) {
        if (f.startsWith('--on=')) opts.on = f.slice('--on='.length);
        else fail(`Unknown flag for start: ${f}`, 'Use --on=<parent> to stack on another feature branch.');
      }
      cmdStart(pos[0], pos[1], opts);
      break;
    }
    case 'ship': {
      const opts = { draft: false, web: false, reviewers: [], labels: [], assignees: [] };
      for (const f of flags) {
        if (f === '--draft') opts.draft = true;
        else if (f === '--web') opts.web = true;
        else if (f.startsWith('--reviewer=')) opts.reviewers.push(...splitList(f.slice('--reviewer='.length)));
        else if (f.startsWith('--label=')) opts.labels.push(...splitList(f.slice('--label='.length)));
        else if (f.startsWith('--assignee=')) opts.assignees.push(...splitList(f.slice('--assignee='.length)));
        else fail(`Unknown flag for ship: ${f}`, 'Use --reviewer=a,b / --label=x / --assignee=@me (with =).');
      }
      await cmdShip(pos[0], opts);
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
      let whenGreen = false;
      for (const f of flags) {
        if (f === '--when-green') whenGreen = true;
        else if (strategies.includes(f)) {
          if (!chosen.includes(f)) chosen.push(f);
        } else fail(`Unknown flag for merge: ${f}`);
      }
      if (chosen.length > 1) fail('Pick one of --merge, --squash, --rebase.');
      await cmdMerge(chosen[0] || '--merge', { whenGreen });
      break;
    }
    case 'done':
      cmdDone(pos[0]);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'list': {
      const opts = {};
      for (const f of flags) {
        if (f === '--plain') opts.plain = true;
        else fail(`Unknown flag for list: ${f}`, 'Use --plain for the non-interactive table.');
      }
      await cmdList(opts);
      break;
    }
    case 'completion':
      cmdCompletion(pos[0]);
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
module.exports = {
  prTitleBody,
  prTemplate,
  defaultBase,
  gitflowInitialized,
  publishPlan,
  parseRepo,
  splitList,
  uniq,
  prCreateArgs,
  tallyChecks,
  checksSummary,
  reviewSummary,
  prCellText,
  isStackedBase,
  effectiveBaseOf,
  stackDepth,
  stackOrder,
  buildListRows,
  branchLabel,
  renderList,
  completionBash,
  completionZsh,
  completionFish,
};
