'use strict';
// Integration tests for `git-shit push` and `git-shit pull` against scratch
// repos, invoking the CLI as a subprocess.
//
// - push offers to stage+commit a dirty tree, but only interactively. Run
//   non-interactively (piped stdin, as here) it must push committed work only,
//   leave the tree untouched, and say so — never commit on its own.
// - pull refuses on a dirty tree, and fast-forwards a clean one.

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
function gsh(cwd, args) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function upstream(cwd) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0 ? r.stdout.trim() : '';
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-pp-'));
const bare = path.join(root, 'origin.git');
const work = path.join(root, 'work');
g(root, ['init', '--quiet', '--bare', bare]);
g(root, ['clone', '--quiet', bare, work]);
g(work, ['config', 'user.email', 't@e.st']);
g(work, ['config', 'user.name', 'Test']);
g(work, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
g(work, ['branch', '-M', 'main']);
g(work, ['push', '--quiet', '-u', 'origin', 'main']);

// --- push: new branch with no upstream -> sets upstream and publishes -------
g(work, ['checkout', '--quiet', '-b', 'feature/x']);
fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
g(work, ['add', '-A']);
g(work, ['commit', '--quiet', '-m', 'add a']);
let r = gsh(work, ['push']);
ok('push: exits 0', r.status === 0);
ok('push: branch now on origin', g(work, ['ls-remote', '--heads', 'origin', 'feature/x']).includes('feature/x'));
eq('push: upstream set to origin/feature/x', upstream(work), 'origin/feature/x');

// --- push: dirty tree, non-interactive -> committed work only, no auto-commit
const beforeCount = g(work, ['rev-list', '--count', 'HEAD']).trim();
fs.writeFileSync(path.join(work, 'a.txt'), 'a-modified\n'); // modified, uncommitted
fs.writeFileSync(path.join(work, 'b.txt'), 'b\n'); // untracked
r = gsh(work, ['push']);
ok('push(dirty): exits 0', r.status === 0);
ok('push(dirty): notes committed-work-only', /committed work only/i.test(r.stdout + r.stderr));
eq('push(dirty): made no commit', g(work, ['rev-list', '--count', 'HEAD']).trim(), beforeCount);
ok('push(dirty): left the tree dirty', g(work, ['status', '--porcelain']).trim().length > 0);

// --- pull: dirty tree -> refuses -------------------------------------------
r = gsh(work, ['pull']);
ok('pull(dirty): exits non-zero', r.status !== 0);
ok('pull(dirty): says commit or stash first', /commit or stash/i.test(r.stdout + r.stderr));

// restore a clean tree
g(work, ['checkout', '--', 'a.txt']);
fs.rmSync(path.join(work, 'b.txt'));

// --- pull: fast-forward from origin ----------------------------------------
// A second clone advances feature/x on origin.
const work2 = path.join(root, 'work2');
g(root, ['clone', '--quiet', bare, work2]);
g(work2, ['config', 'user.email', 't@e.st']);
g(work2, ['config', 'user.name', 'Test']);
g(work2, ['checkout', '--quiet', 'feature/x']);
fs.writeFileSync(path.join(work2, 'c.txt'), 'c\n');
g(work2, ['add', '-A']);
g(work2, ['commit', '--quiet', '-m', 'add c']);
g(work2, ['push', '--quiet', 'origin', 'feature/x']);

const beforePull = Number(g(work, ['rev-list', '--count', 'HEAD']).trim());
r = gsh(work, ['pull']);
ok('pull: exits 0', r.status === 0);
eq('pull: fast-forwarded one commit', Number(g(work, ['rev-list', '--count', 'HEAD']).trim()) - beforePull, 1);
ok('pull: pulled the new file', fs.existsSync(path.join(work, 'c.txt')));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
