'use strict';
// Tests for the publish-plan decision and git-flow detection used by `ship`.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { publishPlan, gitflowInitialized, defaultStartPoint } = require('../bin/git-shit.js');

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

// --- publishPlan(onOrigin, isFeature, gitflowReady) ------------------------
// Already on origin -> just push, regardless of the other inputs.
eq('on origin -> push', publishPlan(true, true, true), 'push');
eq('on origin (non-feature) -> push', publishPlan(true, false, false), 'push');
// Feature branch in a git-flow repo -> git flow feature publish.
eq('feature + git-flow -> flow', publishPlan(false, true, true), 'flow');
// Feature branch WITHOUT git-flow -> plain upstream push (the bug being fixed).
eq('feature + no git-flow -> push-upstream', publishPlan(false, true, false), 'push-upstream');
// Non-feature branch -> plain upstream push either way.
eq('non-feature + git-flow -> push-upstream', publishPlan(false, false, true), 'push-upstream');
eq('non-feature + no git-flow -> push-upstream', publishPlan(false, false, false), 'push-upstream');

// --- gitflowInitialized() runs against the process cwd ---------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-gitflow-'));
g(repo, ['init', '--quiet']);
process.chdir(repo);
eq('fresh repo -> git-flow not initialised', gitflowInitialized(), false);
g(repo, ['config', 'gitflow.prefix.feature', 'feature/']);
eq('after gitflow config -> initialised', gitflowInitialized(), true);

process.chdir(os.tmpdir());
fs.rmSync(repo, { recursive: true, force: true });

// --- defaultStartPoint(develop, base) --------------------------------------
// The start point `start` uses when git-flow isn't initialised and no explicit
// base/parent was given: origin/<develop> > origin/<base> > local develop > HEAD.
const sp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-start-'));
g(sp, ['init', '--quiet']);
g(sp, ['config', 'user.email', 't@e.st']);
g(sp, ['config', 'user.name', 'Test']);
g(sp, ['commit', '--allow-empty', '--quiet', '-m', 'init']);
process.chdir(sp);

// Nothing to branch off but the current branch -> HEAD.
eq('no develop/origin -> HEAD', defaultStartPoint('develop', 'staging'), 'HEAD');

// A local develop is used when there's no origin.
g(sp, ['branch', 'develop']);
eq('local develop -> develop', defaultStartPoint('develop', 'staging'), 'develop');

// An origin base branch beats a merely-local develop.
const originBare = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-origin-'));
g(originBare, ['init', '--bare', '--quiet']);
g(sp, ['remote', 'add', 'origin', originBare]);
g(sp, ['branch', 'staging']);
g(sp, ['push', '--quiet', 'origin', 'staging']);
g(sp, ['fetch', '--quiet', 'origin']);
eq('origin/<base> beats local develop', defaultStartPoint('develop', 'staging'), 'origin/staging');

// origin/<develop> wins over everything else.
g(sp, ['push', '--quiet', 'origin', 'develop']);
g(sp, ['fetch', '--quiet', 'origin']);
eq('origin/<develop> wins', defaultStartPoint('develop', 'staging'), 'origin/develop');

process.chdir(os.tmpdir());
fs.rmSync(sp, { recursive: true, force: true });
fs.rmSync(originBare, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
