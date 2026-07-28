'use strict';
// Unit tests for the pure helpers behind `list`, ship reviewers/labels/
// assignees, repo parsing, and the shell-completion generators. No framework —
// just `node test/list-ship-completion.test.js` (see npm test).

const {
  parseRepo,
  splitList,
  uniq,
  prCreateArgs,
  checksSummary,
  reviewSummary,
  prCellText,
  buildListRows,
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
