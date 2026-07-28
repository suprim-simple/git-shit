'use strict';
// Integration test for auto-restacking: when a stacked parent merges, its
// children should be rebased onto the parent's base, retargeted, and (if
// published) force-pushed. Runs against scratch git repos by invoking the CLI.
// No git-flow / gh needed — a stack is just a branch.<name>.gitshitbase config,
// exactly what `start --on=<parent>` records, so we set it directly here.

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
function commit(cwd, file, subject) {
  fs.writeFileSync(path.join(cwd, file), file + '\n');
  g(cwd, ['add', '-A']);
  g(cwd, ['commit', '--quiet', '-m', subject]);
}
function isAncestor(cwd, a, b) {
  return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd, stdio: 'ignore' }).status === 0;
}
function subjects(cwd, ref) {
  return g(cwd, ['log', '--pretty=%s', ref]).trim().split('\n');
}
function branchExists(cwd, branch) {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, stdio: 'ignore' }).status === 0;
}
function done(cwd) {
  return spawnSync('node', [BIN, 'done'], { cwd, encoding: 'utf8' });
}

// A bare origin + a work clone with a `staging` base pushed to it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-stack-'));
const bare = path.join(root, 'origin.git');
const work = path.join(root, 'work');
g(root, ['init', '--quiet', '--bare', bare]);
g(root, ['clone', '--quiet', bare, work]);
g(work, ['config', 'user.email', 't@t']);
g(work, ['config', 'user.name', 'T']);
g(work, ['config', 'commit.gpgsign', 'false']);
g(work, ['config', 'gitshit.base', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'staging']);
commit(work, 'a.txt', 'base commit');
g(work, ['push', '--quiet', 'origin', 'staging']);

// A parent feature branch off staging...
g(work, ['checkout', '--quiet', '-b', 'feature/parent']);
commit(work, 'p.txt', 'parent work');

// ...and a child stacked on it (what `start --on=parent` records), published.
g(work, ['checkout', '--quiet', '-b', 'feature/child']);
commit(work, 'c.txt', 'child work');
g(work, ['config', 'branch.feature/child.gitshitbase', 'feature/parent']);
g(work, ['push', '--quiet', '-u', 'origin', 'feature/child']);

// The parent's PR merges into staging (fast-forward here), and staging is pushed.
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['merge', '--quiet', '--ff-only', 'feature/parent']);
g(work, ['push', '--quiet', 'origin', 'staging']);

// `done` on the parent should delete it AND restack the child onto staging.
g(work, ['checkout', '--quiet', 'feature/parent']);
{
  const r = done(work);
  eq('done: exit 0', r.status, 0);
  eq('done: parent branch deleted', branchExists(work, 'feature/parent'), false);
  eq('restack: child base retargeted to staging',
    g(work, ['config', 'branch.feature/child.gitshitbase']).trim(), 'staging');
  eq('restack: staging is now an ancestor of the child', isAncestor(work, 'staging', 'feature/child'), true);
  eq('restack: child keeps its own commit', subjects(work, 'feature/child').includes('child work'), true);
  eq('restack: only the child commit sits above staging',
    g(work, ['rev-list', '--count', 'staging..feature/child']).trim(), '1');
  eq('restack: origin child force-pushed to the rebased tip',
    g(work, ['rev-parse', 'feature/child']).trim(), g(work, ['rev-parse', 'origin/feature/child']).trim());
}

// A parent with no children should be a no-op restack (regression guard).
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/lonely']);
commit(work, 'l.txt', 'lonely work');
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['merge', '--quiet', '--ff-only', 'feature/lonely']);
g(work, ['push', '--quiet', 'origin', 'staging']);
g(work, ['checkout', '--quiet', 'feature/lonely']);
{
  const r = done(work);
  eq('no-children done: exit 0', r.status, 0);
  eq('no-children done: branch deleted', branchExists(work, 'feature/lonely'), false);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
