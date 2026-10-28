'use strict';
// Tests for the post-`ship` summary: the pure gh-facts normaliser, shortstat
// parser and line formatter, plus a real-repo check that the local (browser
// flow) facts count commits/files and detect conflicts with the base.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  prSummaryFacts,
  parseShortstat,
  localSummaryFacts,
  shipSummaryLines,
} = require('../bin/git-shit.js');

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

// --- prSummaryFacts (pure) ---------------------------------------------------
const facts = prSummaryFacts({
  commits: [{}, {}, {}],
  changedFiles: 4,
  additions: 120,
  deletions: 7,
  mergeable: 'MERGEABLE',
  statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }],
});
eq('gh facts', facts, { commits: 3, files: 4, additions: 120, deletions: 7, conflicts: false, checks: 'checks: 1/2' });
eq('gh conflicting', prSummaryFacts({ mergeable: 'CONFLICTING' }).conflicts, true);
eq('gh unknown mergeability', prSummaryFacts({ mergeable: 'UNKNOWN' }).conflicts, null);
eq('gh no checks yet', prSummaryFacts({}).checks, 'checks: none reported yet');

// --- parseShortstat (pure) ---------------------------------------------------
eq('shortstat full', parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)'), { files: 3, additions: 10, deletions: 2 });
eq('shortstat singular, no deletions', parseShortstat(' 1 file changed, 1 insertion(+)'), { files: 1, additions: 1, deletions: 0 });
eq('shortstat empty', parseShortstat(''), { files: 0, additions: 0, deletions: 0 });

// --- shipSummaryLines (pure) -------------------------------------------------
eq('summary lines', shipSummaryLines(facts, 'staging'), [
  '    commits:   3',
  '    files:     4 changed  (+120 / -7)',
  '    checks:    1/2',
  '    conflicts: none — merges cleanly into staging',
]);
const conflictLines = shipSummaryLines({ commits: 1, files: 1, additions: 1, deletions: 0, conflicts: true, checks: null }, 'main');
ok('conflict line points at sync', /conflicts: YES .*main.*git-shit sync/.test(conflictLines.join('\n')));
ok('no checks line without checks', !conflictLines.some((l) => /checks:/.test(l)));
ok('unknown conflicts', /unknown/.test(shipSummaryLines({ commits: null, files: null, conflicts: null }, 'x').join('\n')));

// --- localSummaryFacts (real repo) -------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-summary-'));
const origin = path.join(root, 'origin.git');
const work = path.join(root, 'work');
g(root, ['init', '--quiet', '--bare', origin]);
g(root, ['init', '--quiet', work]);
g(work, ['config', 'user.email', 't@e.st']);
g(work, ['config', 'user.name', 'Test']);
g(work, ['checkout', '--quiet', '-b', 'main']);
fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
g(work, ['add', '.']);
g(work, ['commit', '--quiet', '-m', 'init']);
g(work, ['remote', 'add', 'origin', origin]);
g(work, ['push', '--quiet', '-u', 'origin', 'main']);

g(work, ['checkout', '--quiet', '-b', 'feature/x']);
fs.writeFileSync(path.join(work, 'a.txt'), 'feature\n');
g(work, ['commit', '--quiet', '-am', 'change a']);
fs.writeFileSync(path.join(work, 'b.txt'), 'new\nfile\n');
g(work, ['add', '.']);
g(work, ['commit', '--quiet', '-m', 'add b']);

// localSummaryFacts runs git in the process cwd.
const prevCwd = process.cwd();
process.chdir(work);

const clean = localSummaryFacts('main', 'feature/x');
eq('local commits', clean.commits, 2);
eq('local files', clean.files, 2);
eq('local +/-', [clean.additions, clean.deletions], [3, 1]);
eq('local checks unknown', clean.checks, null);

// git merge-tree --write-tree needs git >= 2.38; older git reports unknown.
const [maj, min] = g(work, ['--version']).match(/(\d+)\.(\d+)/).slice(1).map(Number);
const modernGit = maj > 2 || (maj === 2 && min >= 38);
eq('local no conflicts', clean.conflicts, modernGit ? false : null);

// Move origin/main so it conflicts with the feature's edit to a.txt.
g(work, ['checkout', '--quiet', 'main']);
fs.writeFileSync(path.join(work, 'a.txt'), 'upstream\n');
g(work, ['commit', '--quiet', '-am', 'upstream change']);
g(work, ['push', '--quiet', 'origin', 'main']);
g(work, ['checkout', '--quiet', 'feature/x']);
eq('local conflicts detected', localSummaryFacts('main', 'feature/x').conflicts, modernGit ? true : null);

process.chdir(prevCwd);
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
