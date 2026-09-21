'use strict';
// Integration test for `git-shit ship`'s uncommitted-changes handling, run
// against a real scratch repo by invoking the CLI as a subprocess.
//
// `ship` needs a clean tree. When it can run interactively it offers to stage
// everything (git add -A) and commit before shipping; that path needs a TTY, so
// here — with stdin piped (no TTY) — it must fall back to the "commit or stash"
// error and, critically, must NOT stage or commit anything on its own.

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
function ok(name, cond) {
  eq(name, !!cond, true);
}

function g(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A work repo on a feature branch with a dirty tree and a GitHub-shaped origin
// (resolveRepo insists on a github.com/bitbucket.org URL; it never gets fetched
// because the uncommitted-changes check fires first).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-ship-'));
const work = path.join(root, 'work');
g(root, ['init', '--quiet', work]);
g(work, ['config', 'user.email', 't@e.st']);
g(work, ['config', 'user.name', 'Test']);
g(work, ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
g(work, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
g(work, ['checkout', '--quiet', '-b', 'feature/x']);
fs.writeFileSync(path.join(work, 'file.txt'), 'dirty\n');

// stdin is 'ignore' (not a TTY) -> ship can't prompt -> must fall back.
const r = spawnSync('node', [BIN, 'ship', 'main'], {
  cwd: work,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const outErr = (r.stdout || '') + (r.stderr || '');

ok('non-interactive dirty ship exits non-zero', r.status !== 0);
ok('reports the uncommitted-changes error', /uncommitted changes/i.test(outErr));
// It must not stage or commit anything without a confirmed prompt.
eq('tree left untouched', g(work, ['status', '--porcelain']).trim(), '?? file.txt');
eq('no new commit created', g(work, ['rev-list', '--count', 'HEAD']).trim(), '1');

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
