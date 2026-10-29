'use strict';
// A branch shipped to several bases (e.g. main and production) has one open PR
// per base. These tests cover that end to end: `ship main production` opens
// both, re-shipping finds the right one, `status` shows both, `merge` makes you
// pick, and the branch is only cleaned up once its last PR merges. Plus the
// pure `list` helper that picks which PR a branch's row shows.
//
// The e2e part runs the CLI against a scratch repo whose origin is a local bare
// repo, with a fake `gh` (PRs kept as JSON files) and a `git` wrapper that
// reports a github.com URL for origin — so nothing touches GitHub.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pickBranchPr, prCellText, parseLsRemote } = require('../bin/git-shit.js');

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

// --- pickBranchPr / prCellText ------------------------------------------------

const toMain = { number: 1, state: 'OPEN', baseRefName: 'main' };
const toProd = { number: 2, state: 'OPEN', baseRefName: 'production' };
const merged = { number: 3, state: 'MERGED', baseRefName: 'main' };

eq('pick: none', pickBranchPr([], 'main'), undefined);
eq('pick: open PR into the branch base wins', pickBranchPr([toProd, toMain], 'main').number, 1);
eq('pick: other open PRs ride along', pickBranchPr([toProd, toMain], 'main').alsoOpen.map((p) => p.number), [2]);
eq('pick: any open beats a newer merged one', pickBranchPr([merged, toProd], 'main').number, 2);
eq('pick: falls back to newest when none open', pickBranchPr([merged], 'main').number, 3);
eq('pick: single PR has no alsoOpen', pickBranchPr([toMain], 'main').alsoOpen, undefined);
eq(
  'cell: mentions the other open PRs',
  prCellText({ ...toMain, alsoOpen: [toProd] }, true, true),
  '#1 · open · also #2 -> production'
);

eq(
  'ls-remote: parses heads, ignores junk',
  [...parseLsRemote('abc123\trefs/heads/main\ndef456\trefs/heads/feature/x\nwarning: hi\n')],
  [['main', 'abc123'], ['feature/x', 'def456']]
);

// --- e2e: ship / status / merge across two bases ------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-multi-'));
const fakeBin = path.join(root, 'bin');
const prDir = path.join(root, 'prs');
fs.mkdirSync(fakeBin);
fs.mkdirSync(prDir);

const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
fs.writeFileSync(
  path.join(fakeBin, 'git'),
  `#!/bin/sh
if [ "$1 $2 $3" = "remote get-url origin" ]; then echo https://github.com/acme/widgets.git; exit 0; fi
exec ${JSON.stringify(realGit)} "$@"
`
);

// Fake gh: each PR is prs/<number>.json. Supports what ship/merge/status use.
fs.writeFileSync(
  path.join(fakeBin, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(prDir)};
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i < 0 ? undefined : a[i + 1]; };
const all = () => fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .sort((x, y) => y.number - x.number);
const save = (pr) => fs.writeFileSync(path.join(dir, pr.number + '.json'), JSON.stringify(pr));
const full = (pr) => ({ ...pr, url: 'https://github.com/acme/widgets/pull/' + pr.number, isDraft: false,
  commits: [{}], changedFiles: 1, additions: 1, deletions: 0, mergeable: 'MERGEABLE', statusCheckRollup: [],
  reviewDecision: '', mergeStateStatus: 'CLEAN' });
const cmd = a[0] + ' ' + a[1];
if (cmd === 'auth token') { console.log('tok'); process.exit(0); }
if (cmd === 'pr list') {
  let prs = all();
  if (opt('--head')) prs = prs.filter((p) => p.headRefName === opt('--head'));
  if (opt('--base')) prs = prs.filter((p) => p.baseRefName === opt('--base'));
  if (opt('--state') === 'open') prs = prs.filter((p) => p.state === 'OPEN');
  console.log(JSON.stringify(prs.map(full)));
  process.exit(0);
}
if (a[0] === 'api' && a.includes('repos/acme/widgets/pulls')) {
  // REST create: fields come as -f key=value.
  const f = {};
  a.forEach((x, i) => { if ((x === '-f' || x === '-F') && a[i + 1]) { const [k, ...v] = a[i + 1].split('='); f[k] = v.join('='); } });
  const number = all().length + 1;
  save({ number, headRefName: f.head, baseRefName: f.base, state: 'OPEN', title: f.title, draft: f.draft === 'true' });
  console.log(JSON.stringify({ number, html_url: 'https://github.com/acme/widgets/pull/' + number, draft: f.draft === 'true' }));
  process.exit(0);
}
if (cmd === 'pr view') {
  const pr = /^\\d+$/.test(a[2]) ? all().find((p) => p.number === Number(a[2])) : all().find((p) => p.headRefName === a[2]);
  if (!pr) process.exit(1);
  console.log(JSON.stringify(full(pr)));
  process.exit(0);
}
if (cmd === 'pr merge') {
  const pr = all().find((p) => p.number === Number(a[2]));
  save({ ...pr, state: 'MERGED' });
  process.exit(0);
}
process.exit(1);
`
);
for (const f of ['git', 'gh']) fs.chmodSync(path.join(fakeBin, f), 0o755);

function g(cwd, args) {
  return execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const origin = path.join(root, 'origin.git');
const work = path.join(root, 'work');
g(root, ['init', '--quiet', '--bare', origin]);
g(root, ['init', '--quiet', work]);
g(work, ['config', 'user.email', 't@e.st']);
g(work, ['config', 'user.name', 'Test']);
g(work, ['remote', 'add', 'origin', origin]);
g(work, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
g(work, ['branch', '-M', 'main']);
g(work, ['push', '--quiet', 'origin', 'main', 'main:production']);
// A branch on origin that ship has no business fetching.
g(root, ['--git-dir', path.join(root, 'origin.git'), 'branch', 'unrelated', 'main']);
g(work, ['checkout', '--quiet', '-b', 'feature/x']);
fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
g(work, ['add', 'a.txt']);
g(work, ['commit', '--quiet', '-m', 'add a']);

function cli(...args) {
  const r = spawnSync('node', [BIN, ...args], {
    cwd: work,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const prs = () =>
  fs.readdirSync(prDir).map((f) => JSON.parse(fs.readFileSync(path.join(prDir, f), 'utf8')))
    .sort((x, y) => x.number - y.number)
    .map((p) => `#${p.number} ${p.baseRefName} ${p.state}`);

let r = cli('ship', 'main', 'production');
eq('ship two bases: exits 0', r.status, 0);
eq('ship two bases: one PR into each', prs(), ['#1 main OPEN', '#2 production OPEN']);
ok('ship two bases: pushed once', (r.out.match(/Push feature\/x/g) || []).length === 2); // ▸ + ✓ lines

r = cli('ship', 'production');
eq('re-ship production: no new PR', prs(), ['#1 main OPEN', '#2 production OPEN']);
ok('re-ship production: finds #2, not the main PR', /#2 already open/.test(r.out));

ok('targeted fetch: unrelated origin branch not fetched', !g(work, ['branch', '-r']).includes('origin/unrelated'));
ok('targeted fetch: nothing moved -> no fetch', /Fetch origin {2}already current/.test(r.out));

// Someone else lands a commit on main; shipping to main must pick it up (the
// PR body/summary/conflict check read origin/main), production stays put.
const other = path.join(root, 'other');
g(root, ['clone', '--quiet', '--branch', 'main', origin, other]);
g(other, ['-c', 'user.email=o@e.st', '-c', 'user.name=O', 'commit', '--quiet', '--allow-empty', '-m', 'teammate']);
g(other, ['push', '--quiet', 'origin', 'main']);
const mainTip = g(other, ['rev-parse', 'HEAD']).trim();
r = cli('ship', 'main');
ok('targeted fetch: moved base gets fetched', /Fetch origin {2}updated main/.test(r.out));
eq('targeted fetch: origin/main now current', g(work, ['rev-parse', 'origin/main']).trim(), mainTip);

r = cli('status');
ok('status: lists the main PR', /#1 -> main/.test(r.out));
ok('status: lists the production PR', /#2 -> production/.test(r.out));

r = cli('merge');
ok('merge without dest: refuses', r.status !== 0);
ok('merge without dest: suggests each dest', /merge main/.test(r.out) && /merge production/.test(r.out));
eq('merge without dest: merged nothing', prs(), ['#1 main OPEN', '#2 production OPEN']);

r = cli('merge', 'production');
eq('merge production: exits 0', r.status, 0);
eq('merge production: merged #2 only', prs(), ['#1 main OPEN', '#2 production MERGED']);
ok('merge production: keeps the branch', /Keeping 'feature\/x'/.test(r.out));
eq('merge production: still on the branch', g(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/x');

r = cli('merge', 'main');
eq('merge main: exits 0', r.status, 0);
eq('merge main: merged #1', prs(), ['#1 main MERGED', '#2 production MERGED']);
eq('merge main: last PR cleans up (back on main)', g(work, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
ok('merge main: local branch deleted', !g(work, ['branch', '--list', 'feature/x']).trim());

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
if (failed) process.exit(1);
