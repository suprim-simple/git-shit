'use strict';
// Tests for the publish-plan decision and git-flow detection used by `ship`.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { publishPlan, gitflowInitialized } = require('../bin/git-shit.js');

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

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
