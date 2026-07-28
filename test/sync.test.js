'use strict';
// Integration tests for `git-shit sync`, run against real scratch git repos by
// invoking the CLI as a subprocess. No test framework — just
// `node test/sync.test.js` (see npm test).

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'git-shit.js');

let pass = 0;
let failed = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}

function g(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Run the CLI in `cwd`; capture status/stdout/stderr regardless of exit code.
function sync(cwd, args = []) {
  return spawnSync('node', [BIN, 'sync', ...args], { cwd, encoding: 'utf8' });
}

function commit(cwd, file, subject) {
  fs.writeFileSync(path.join(cwd, file), file + '\n');
  g(cwd, ['add', '-A']);
  g(cwd, ['commit', '--quiet', '-m', subject]);
}

// Add a commit to staging and push it, simulating the base moving ahead.
// Leaves the repo checked out on staging.
function advanceStaging(cwd, file, subject) {
  g(cwd, ['checkout', '--quiet', 'staging']);
  commit(cwd, file, subject);
  g(cwd, ['push', '--quiet', 'origin', 'staging']);
}

function isAncestor(cwd, a, b) {
  return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, stdio: 'ignore' }).status === 0;
}

function logSubjects(cwd, ref) {
  return g(cwd, ['log', '--pretty=%s', ref]).trim().split('\n');
}

// A bare origin + a work clone with a `staging` base branch pushed to it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-sync-'));
const bare = path.join(root, 'origin.git');
const work = path.join(root, 'work');
g(root, ['init', '--quiet', '--bare', bare]);
g(root, ['clone', '--quiet', bare, work]);
g(work, ['config', 'user.email', 't@t']);
g(work, ['config', 'user.name', 'T']);
g(work, ['config', 'commit.gpgsign', 'false']);
// Pin the base so an ambient global gitshit.base can't sway the test.
g(work, ['config', 'gitshit.base', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'staging']);
commit(work, 'a.txt', 'base commit');
g(work, ['push', '--quiet', 'origin', 'staging']);

// --- rebase (default): base commits land under the feature's work -----------
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/sync-rebase']);
commit(work, 'r1.txt', 'feature work');
advanceStaging(work, 's1.txt', 'staging moved');
g(work, ['checkout', '--quiet', 'feature/sync-rebase']);
{
  const r = sync(work);
  eq('rebase: exit 0', r.status, 0);
  eq('rebase: base is now an ancestor', isAncestor(work, 'origin/staging', 'HEAD'), true);
  eq('rebase: feature commit preserved', logSubjects(work, 'HEAD').includes('feature work'), true);
  eq('rebase: tip is the feature commit (rebased on top)', logSubjects(work, 'HEAD')[0], 'feature work');
}

// --- idempotent: a second sync has nothing to do ----------------------------
{
  const r = sync(work);
  eq('up-to-date: exit 0', r.status, 0);
  eq('up-to-date: reports nothing to do', /Already up to date/.test(r.stdout), true);
}

// --- --merge: base is merged in as a merge commit ---------------------------
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/sync-merge']);
commit(work, 'm1.txt', 'feature work for merge');
advanceStaging(work, 's2.txt', 'staging moved again');
g(work, ['checkout', '--quiet', 'feature/sync-merge']);
{
  const r = sync(work, ['--merge']);
  eq('merge: exit 0', r.status, 0);
  eq('merge: base is now an ancestor', isAncestor(work, 'origin/staging', 'HEAD'), true);
  const parents = g(work, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/);
  eq('merge: HEAD is a merge commit (two parents)', parents.length, 3);
}

// --- published branch + rebase: reminds you to force-push the PR -------------
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/sync-pub']);
commit(work, 'p1.txt', 'published feature work');
g(work, ['push', '--quiet', '-u', 'origin', 'feature/sync-pub']);
advanceStaging(work, 's3.txt', 'staging moved for pub');
g(work, ['checkout', '--quiet', 'feature/sync-pub']);
{
  const r = sync(work);
  eq('published rebase: exit 0', r.status, 0);
  eq('published rebase: force-push reminder shown', /force-with-lease/.test(r.stdout), true);
}

// --- conflict: leaves the rebase in place and prints how to recover ----------
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/sync-conflict']);
fs.writeFileSync(path.join(work, 'shared.txt'), 'feature version\n');
g(work, ['add', '-A']);
g(work, ['commit', '--quiet', '-m', 'feature edits shared']);
g(work, ['checkout', '--quiet', 'staging']);
fs.writeFileSync(path.join(work, 'shared.txt'), 'staging version\n');
g(work, ['add', '-A']);
g(work, ['commit', '--quiet', '-m', 'staging edits shared']);
g(work, ['push', '--quiet', 'origin', 'staging']);
g(work, ['checkout', '--quiet', 'feature/sync-conflict']);
{
  const r = sync(work);
  eq('conflict: non-zero exit', r.status !== 0, true);
  eq('conflict: recovery hint shown', /rebase --abort/.test(r.stdout + r.stderr), true);
  g(work, ['rebase', '--abort']); // clean up the in-progress rebase
}

// --- dirty tree: refuses before touching anything ---------------------------
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/sync-dirty']);
commit(work, 'd1.txt', 'feature work dirty');
advanceStaging(work, 's4.txt', 'staging moved dirty');
g(work, ['checkout', '--quiet', 'feature/sync-dirty']);
fs.writeFileSync(path.join(work, 'd1.txt', ), 'uncommitted change\n');
{
  const r = sync(work);
  eq('dirty: non-zero exit', r.status !== 0, true);
  eq('dirty: complains about uncommitted changes', /uncommitted changes/.test(r.stderr), true);
  eq('dirty: did not start a rebase', isAncestor(work, 'origin/staging', 'HEAD'), false);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
