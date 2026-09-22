'use strict';
// Tests for `git-shit checkout`: the pure branch-row parser/renderer, plus
// integration checks that a direct `checkout <name>` switches branches (with a
// feature/<name> fallback) and that --plain lists local branches.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBranches, renderBranches } = require('../bin/git-shit.js');
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

// --- parseBranches (pure) --------------------------------------------------
const rows = parseBranches(
  [
    'feature/x\t*\t2 hours ago\tAdd the thing',
    'main\t\t3 days ago\tInitial commit',
    'feature/tabbed\t\t1 week ago\tSubject\twith\ttabs',
  ].join('\n')
);
eq('parse: three rows', rows.length, 3);
eq('parse: current marked', rows[0], { branch: 'feature/x', current: true, age: '2 hours ago', subject: 'Add the thing' });
eq('parse: non-current', rows[1].current, false);
eq('parse: subject keeps embedded tabs', rows[2].subject, 'Subject\twith\ttabs');
eq('parse: empty input -> no rows', parseBranches(''), []);

// --- renderBranches (pure) -------------------------------------------------
const table = renderBranches(rows);
ok('render: header row', /BRANCH\s+AGE\s+LAST COMMIT/.test(table[0]));
ok('render: marks current branch with *', table.some((l) => l.startsWith('* feature/x')));
ok('render: lists non-current without a mark', table.some((l) => /^\s{2}main\b/.test(l)));

// --- integration: direct checkout ------------------------------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-co-'));
g(repo, ['init', '--quiet']);
g(repo, ['config', 'user.email', 't@e.st']);
g(repo, ['config', 'user.name', 'Test']);
g(repo, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
g(repo, ['branch', '-M', 'main']);
g(repo, ['branch', 'develop']);
g(repo, ['branch', 'feature/login']);

// exact-name checkout
let r = gsh(repo, ['checkout', 'develop']);
ok('checkout develop: exits 0', r.status === 0);
eq('checkout develop: now on develop', g(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'develop');

// short feature name -> feature/<name> fallback
r = gsh(repo, ['checkout', 'login']);
ok('checkout login: exits 0', r.status === 0);
eq('checkout login: resolved to feature/login', g(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/login');

// --plain lists local branches with the current one marked
r = gsh(repo, ['checkout', '--plain']);
ok('checkout --plain: exits 0', r.status === 0);
ok('checkout --plain: shows main', /(^|\n)\s*main\b/.test(r.stdout));
ok('checkout --plain: marks current (feature/login) with *', /\*\s+feature\/login\b/.test(r.stdout));

// unknown branch -> error exit
r = gsh(repo, ['checkout', 'no-such-branch']);
ok('checkout missing: exits non-zero', r.status !== 0);

fs.rmSync(repo, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
