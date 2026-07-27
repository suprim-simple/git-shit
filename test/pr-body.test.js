'use strict';
// Integration tests for prTitleBody / prTemplate, run against real scratch git
// repos. No test framework — just `node test/pr-body.test.js` (see npm test).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { prTitleBody, prTemplate } = require('../bin/git-shit.js');

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

// A bare origin + a work clone with a `staging` base branch pushed to it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-prbody-'));
const bare = path.join(root, 'origin.git');
const work = path.join(root, 'work');
g(root, ['init', '--quiet', '--bare', bare]);
g(root, ['clone', '--quiet', bare, work]);
g(work, ['config', 'user.email', 't@t']);
g(work, ['config', 'user.name', 'T']);
g(work, ['config', 'commit.gpgsign', 'false']);
g(work, ['checkout', '--quiet', '-b', 'staging']);
fs.writeFileSync(path.join(work, 'a.txt'), 'a');
g(work, ['add', '-A']);
g(work, ['commit', '--quiet', '-m', 'base commit']);
g(work, ['push', '--quiet', 'origin', 'staging']);

function commit(file, subject, body) {
  fs.writeFileSync(path.join(work, file), file);
  g(work, ['add', '-A']);
  const args = ['commit', '--quiet', '-m', subject];
  if (body) args.push('-m', body);
  g(work, args);
}

// prTitleBody/prTemplate read via git in the process cwd.
process.chdir(work);

// Single commit -> subject as title, full message body as body.
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/one']);
commit('b.txt', 'Only change', 'The detailed body.\nSecond line.');
g(work, ['fetch', '--quiet', 'origin']);
eq('single commit -> subject + full body',
   prTitleBody('staging', 'feature/one'),
   { title: 'Only change', body: 'The detailed body.\nSecond line.' });

// Multiple commits -> first subject as title, bullet list (oldest first) as body.
g(work, ['checkout', '--quiet', 'staging']);
g(work, ['checkout', '--quiet', '-b', 'feature/multi']);
commit('c.txt', 'First change', 'ignored body when multi');
commit('d.txt', 'Second change');
commit('e.txt', 'Third change');
eq('multi commit -> first subject as title',
   prTitleBody('staging', 'feature/multi').title,
   'First change');
eq('multi commit -> bullet list body (oldest first)',
   prTitleBody('staging', 'feature/multi').body,
   '- First change\n- Second change\n- Third change');

// A PR template wins as the body; the title still comes from the commits.
fs.mkdirSync(path.join(work, '.github'), { recursive: true });
const tpl = '## Summary\n\n## Checklist\n- [ ] tests';
fs.writeFileSync(path.join(work, '.github/pull_request_template.md'), tpl + '\n');
eq('prTemplate() finds .github/pull_request_template.md', prTemplate(), tpl);
eq('template replaces the generated body',
   prTitleBody('staging', 'feature/multi').body,
   tpl);
eq('title still from commits with a template present',
   prTitleBody('staging', 'feature/multi').title,
   'First change');

// Unresolvable base -> fall back to the branch's tip commit.
fs.rmSync(path.join(work, '.github'), { recursive: true, force: true });
eq('unknown base -> tip subject/body',
   prTitleBody('does-not-exist', 'feature/one'),
   { title: 'Only change', body: 'The detailed body.\nSecond line.' });

process.chdir(root);
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
