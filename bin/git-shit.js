#!/usr/bin/env node
//
// git-shit — git-flow feature workflow that ends in a PR into staging
//
// Workflow:
//   1. git-shit start my-fix   -> runs `git flow feature start my-fix`
//   2. ...do your work, commit as usual...
//   3. git-shit ship           -> pushes the feature branch, opens the
//                                  pre-filled PR page in Chrome, waits
//                                  for it to load, and auto-clicks
//                                  "Create pull request". You just
//                                  click Merge.
//
// One-time Chrome setup (required for the auto-click):
//   Chrome menu bar -> View -> Developer -> Allow JavaScript from Apple Events
//   (Without it, the tool still opens the PR page; you click Create yourself.)
//
// Requires: git, git-flow, macOS + Google Chrome for the auto-click
//
// Notes:
//   - Workspace + repo slug are auto-detected from the `origin` remote URL.
//   - Assumes git-flow is initialised (`git flow init`) with feature prefix "feature/".
//   - `git flow feature finish` is deliberately NOT used: it merges locally and
//     pushes directly — here the merge into staging happens through a PR.

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_BRANCH = 'staging';
const PROG = 'git-shit';

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

function usage() {
  console.log(`Usage:
  ${PROG} start <name>   Start a new git-flow feature
  ${PROG} ship [dest]    Push current feature, open PR page, auto-click Create
                         (dest = PR target branch, default: ${BASE_BRANCH})
  ${PROG} done [dest]    After the PR is merged: checkout dest, pull, delete
                         the local feature branch, prune stale refs
  ${PROG} status         Show branch, publish state, and commits vs ${BASE_BRANCH}`);
  process.exit(1);
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

function cmdStart(name) {
  if (!name) fail(`Usage: ${PROG} start <name>`);
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

  console.log(`==> git flow feature start ${name}`);
  run('git', ['flow', 'feature', 'start', name]);
  console.log('');
  console.log(`Feature branch '${featurePrefix()}${name}' created.`);
  console.log(`Do your work, commit, then run: ${PROG} ship`);
}

async function cmdShip(dest) {
  const baseBranch = dest || BASE_BRANCH;
  const repo = resolveRepo();
  const prefix = featurePrefix();

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  if (!branch.startsWith(prefix)) {
    fail(
      `Current branch '${branch}' is not a git-flow feature branch (${prefix}*).`,
      'Check out your feature branch first, or start one with:',
      `  ${PROG} start <name>`
    );
  }

  if (git(['status', '--porcelain']) !== '') {
    fail('You have uncommitted changes. Commit or stash them before shipping.');
  }

  const featureName = branch.slice(prefix.length);

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
      `Usage: ${PROG} ship [dest]   (default: ${BASE_BRANCH})`
    );
  }

  const onOrigin =
    spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], {
      stdio: 'ignore',
    }).status === 0;

  if (onOrigin) {
    // Branch already exists on origin — just push the latest commits.
    console.log('==> Branch already published, pushing latest commits...');
    run('git', ['push', 'origin', branch]);
  } else {
    console.log(`==> Publishing feature branch (git flow feature publish ${featureName})...`);
    run('git', ['flow', 'feature', 'publish', featureName]);
  }

  const prUrl = buildPrUrl(repo, branch, baseBranch);
  console.log(`==> Opening PR page: ${branch} -> ${baseBranch}`);
  openUrl(prUrl);

  await autoClickCreate();

  console.log('');
  console.log('After merging in Chrome, sync up locally with:');
  console.log(`  git checkout ${baseBranch} && git pull origin ${baseBranch}`);
  console.log(`  git branch -D ${branch} && git fetch --prune origin`);
}

function cmdDone(dest) {
  const baseBranch = dest || BASE_BRANCH;
  const prefix = featurePrefix();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

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

  console.log(`Branch:     ${branch}${isFeature ? '' : `  (not a ${prefix}* branch)`}`);
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
    const counts = git(['rev-list', '--left-right', '--count', `origin/${BASE_BRANCH}...HEAD`]);
    const [behind, ahead] = counts.split(/\s+/);
    console.log(`vs ${BASE_BRANCH}: ${ahead} ahead, ${behind} behind origin/${BASE_BRANCH} (as of last fetch)`);
  } catch {
    console.log(`vs ${BASE_BRANCH}: unknown (no origin/${BASE_BRANCH} ref — fetch first)`);
  }

  if (isFeature) {
    const repo = resolveRepo();
    console.log(`PR page:    ${buildPrUrl(repo, branch, BASE_BRANCH)}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'start':
      cmdStart(rest[0]);
      break;
    case 'ship':
      await cmdShip(rest[0]);
      break;
    case 'done':
      cmdDone(rest[0]);
      break;
    case 'status':
      cmdStatus();
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});
