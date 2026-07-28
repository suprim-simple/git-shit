'use strict';
// Unit tests for the pure helpers behind `list`, ship reviewers/labels/
// assignees, repo parsing, and the shell-completion generators. No framework —
// just `node test/list-ship-completion.test.js` (see npm test).

const {
  parseRepo,
  splitList,
  uniq,
  prCreateArgs,
  tallyChecks,
  checksSummary,
  reviewSummary,
  prCellText,
  isStackedBase,
  stackDepth,
  stackOrder,
  buildListRows,
  branchLabel,
  renderList,
  completionBash,
  completionZsh,
  completionFish,
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

// --- parseRepo --------------------------------------------------------------
eq('parseRepo: github ssh',
  parseRepo('git@github.com:owner/repo.git'),
  { host: 'github', web: 'https://github.com/owner/repo' });
eq('parseRepo: github https',
  parseRepo('https://github.com/owner/repo.git'),
  { host: 'github', web: 'https://github.com/owner/repo' });
eq('parseRepo: bitbucket ssh',
  parseRepo('git@bitbucket.org:ws/repo.git'),
  { host: 'bitbucket', web: 'https://bitbucket.org/ws/repo' });
eq('parseRepo: bitbucket https with user',
  parseRepo('https://user@bitbucket.org/ws/repo.git'),
  { host: 'bitbucket', web: 'https://bitbucket.org/ws/repo' });
eq('parseRepo: no .git suffix', parseRepo('https://github.com/owner/repo').web, 'https://github.com/owner/repo');
eq('parseRepo: unknown host -> null', parseRepo('git@example.com:x/y.git'), null);
eq('parseRepo: empty -> null', parseRepo(''), null);

// --- splitList / uniq -------------------------------------------------------
eq('splitList: trims and drops empties', splitList('a, b ,,c'), ['a', 'b', 'c']);
eq('splitList: empty -> []', splitList(''), []);
eq('splitList: null -> []', splitList(null), []);
eq('uniq: preserves first-seen order', uniq(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);

// --- prCreateArgs -----------------------------------------------------------
eq('prCreateArgs: minimal',
  prCreateArgs({ base: 'main', head: 'feature/x', title: 'T', body: 'B' }),
  ['pr', 'create', '--base', 'main', '--head', 'feature/x', '--title', 'T', '--body', 'B']);
eq('prCreateArgs: title falls back to head',
  prCreateArgs({ base: 'main', head: 'feature/x', title: '', body: '' }).slice(6, 8),
  ['--title', 'feature/x']);
eq('prCreateArgs: draft + people as repeated flags',
  prCreateArgs({
    base: 'main', head: 'feature/x', title: 'T', body: 'B', draft: true,
    reviewers: ['alice', 'bob'], labels: ['feat'], assignees: ['@me'],
  }),
  ['pr', 'create', '--base', 'main', '--head', 'feature/x', '--title', 'T', '--body', 'B',
    '--draft', '--reviewer', 'alice', '--reviewer', 'bob', '--label', 'feat', '--assignee', '@me']);

// --- checksSummary ----------------------------------------------------------
eq('checks: empty/none -> ""', checksSummary([]), '');
eq('checks: not an array -> ""', checksSummary(undefined), '');
eq('checks: all success (CheckRun conclusion)',
  checksSummary([{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }]), 'checks: ok');
eq('checks: any failure wins',
  checksSummary([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]), 'checks: 1 failing');
eq('checks: pending shows passed/total',
  checksSummary([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]), 'checks: 1/2');
eq('checks: StatusContext uses .state',
  checksSummary([{ state: 'SUCCESS' }, { state: 'PENDING' }]), 'checks: 1/2');

// --- tallyChecks (backs both the summary and `merge --when-green`) ----------
eq('tally: none', tallyChecks([]), { pass: 0, fail: 0, pending: 0, total: 0 });
eq('tally: not an array', tallyChecks(undefined), { pass: 0, fail: 0, pending: 0, total: 0 });
eq('tally: mixed conclusions',
  tallyChecks([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]),
  { pass: 2, fail: 1, pending: 1, total: 4 });
eq('tally: StatusContext state', tallyChecks([{ state: 'SUCCESS' }, { state: 'PENDING' }]),
  { pass: 1, fail: 0, pending: 1, total: 2 });

// --- reviewSummary ----------------------------------------------------------
eq('review: approved', reviewSummary('APPROVED'), 'approved');
eq('review: changes requested', reviewSummary('CHANGES_REQUESTED'), 'changes requested');
eq('review: required -> pending', reviewSummary('REVIEW_REQUIRED'), 'review pending');
eq('review: null -> ""', reviewSummary(null), '');

// --- prCellText -------------------------------------------------------------
eq('prCell: open PR with checks + review',
  prCellText({ number: 7, state: 'OPEN', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }], reviewDecision: 'APPROVED' }, true, true),
  '#7 · open · checks: ok · approved');
eq('prCell: draft label', prCellText({ number: 8, state: 'OPEN', isDraft: true }, true, true), '#8 · draft');
eq('prCell: no PR but gh available + published -> "no PR"', prCellText(null, true, true), 'no PR');
eq('prCell: no PR, unpublished -> "—"', prCellText(null, false, true), '—');
eq('prCell: gh unavailable -> "" (unknown)', prCellText(null, true, false), '');

// --- buildListRows / renderList ---------------------------------------------
const rows = buildListRows({
  branches: ['feature/a', 'feature/b'],
  current: 'feature/a',
  remoteHeads: new Set(['feature/a']),
  prByBranch: {
    'feature/a': { number: 5, state: 'OPEN', isDraft: false, baseRefName: 'main', statusCheckRollup: [], reviewDecision: null },
  },
  baseOf: () => 'staging',
  ghAvailable: true,
});
eq('rows: current branch marked', rows[0].mark, '*');
eq('rows: other branch not marked', rows[1].mark, ' ');
eq('rows: PR base wins the base column', rows[0].base, 'main');
eq('rows: no-PR branch falls back to recorded/default base', rows[1].base, 'staging');
eq('rows: published vs local only', [rows[0].state, rows[1].state], ['published', 'local only']);
eq('rows: unpublished + gh available -> "—"', rows[1].pr, '—');

const lines = renderList(rows);
ok('render: has a header row', /^\s+BRANCH\s+BASE\s+STATE\s+PR$/.test(lines[0]));
ok('render: marks current branch line with *', lines[1].startsWith('* feature/a'));
ok('render: columns are padded to align', lines[1].indexOf('main') === lines[2].indexOf('staging'));

// --- stacking: isStackedBase / stackDepth / stackOrder / branchLabel --------
ok('stacked: a feature-prefixed base is a stack parent', isStackedBase('feature/a', 'feature/'));
ok('stacked: a long-lived base is not', !isStackedBase('staging', 'feature/'));
ok('stacked: empty base is not', !isStackedBase('', 'feature/'));

// feature/c -> feature/b -> feature/a -> staging  (a chain two deep)
const chain = ['feature/a', 'feature/b', 'feature/c'];
const chainBase = { 'feature/a': 'staging', 'feature/b': 'feature/a', 'feature/c': 'feature/b' };
const chainSet = new Set(chain);
const effOf = (b) => chainBase[b];
eq('depth: root of a stack is 0', stackDepth('feature/a', chainSet, effOf), 0);
eq('depth: child is 1', stackDepth('feature/b', chainSet, effOf), 1);
eq('depth: grandchild is 2', stackDepth('feature/c', chainSet, effOf), 2);
eq('depth: base outside the set stays 0',
  stackDepth('feature/x', new Set(['feature/x']), () => 'staging'), 0);

// Children follow their parent even when input order is shuffled by date.
eq('order: children slot under parents',
  stackOrder(['feature/c', 'feature/a', 'feature/b'], effOf),
  ['feature/a', 'feature/b', 'feature/c']);
eq('order: independent roots keep their input order',
  stackOrder(['feature/z', 'feature/y'], () => 'staging'),
  ['feature/z', 'feature/y']);

eq('label: root branch is not indented', branchLabel({ branch: 'feature/a', depth: 0 }), 'feature/a');
ok('label: stacked child gets a tree glyph', branchLabel({ branch: 'feature/b', depth: 1 }).includes('feature/b'));
ok('label: deeper child is indented further',
  branchLabel({ branch: 'feature/c', depth: 2 }).length > branchLabel({ branch: 'feature/b', depth: 1 }).length);

// buildListRows carries depth from the effective base (PR target wins).
const stackRows = buildListRows({
  branches: ['feature/a', 'feature/b'],
  current: 'feature/b',
  remoteHeads: new Set(['feature/a', 'feature/b']),
  prByBranch: { 'feature/b': { number: 9, state: 'OPEN', isDraft: false, baseRefName: 'feature/a', statusCheckRollup: [], reviewDecision: null } },
  baseOf: () => 'staging',
  ghAvailable: true,
});
eq('rows: stacked child reports depth 1', stackRows[1].depth, 1);
eq('rows: stack parent reports depth 0', stackRows[0].depth, 0);
eq('rows: child base column shows the parent', stackRows[1].base, 'feature/a');

// --- completion generators --------------------------------------------------
for (const [shell, gen] of [['bash', completionBash], ['zsh', completionZsh], ['fish', completionFish]]) {
  const script = gen();
  ok(`completion ${shell}: mentions every command`, ['start', 'ship', 'sync', 'merge', 'done', 'status', 'list', 'completion'].every((c) => script.includes(c)));
  ok(`completion ${shell}: includes ship flags`, script.includes('reviewer') && script.includes('label') && script.includes('assignee'));
  ok(`completion ${shell}: non-empty`, script.length > 100);
}
ok('completion zsh: has #compdef header', completionZsh().startsWith('#compdef git-shit'));
ok('completion bash: registers complete', completionBash().includes('complete -F _git_shit git-shit'));
ok('completion fish: uses subcommand predicate', completionFish().includes('__fish_use_subcommand'));

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
