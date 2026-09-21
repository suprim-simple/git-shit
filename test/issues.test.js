'use strict';
// Unit tests for the pure helpers behind `git-shit issues`: title slugging,
// branch naming, PR issue-linking, relative ages, row shaping, and the static
// table. No framework — just `node test/issues.test.js` (see npm test).

const {
  slugify,
  issueBranchName,
  withIssueClose,
  relAge,
  issueRow,
  renderIssues,
  scrollTop,
  issuesPerPage,
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

// --- slugify ---------------------------------------------------------------
eq('slug: basic', slugify('Fix the login bug'), 'fix-the-login-bug');
eq('slug: collapses & trims punctuation', slugify('  Add: OAuth (v2)!! '), 'add-oauth-v2');
eq('slug: lowercases', slugify('CRASH On Start'), 'crash-on-start');
eq('slug: caps length and trims trailing dash', slugify('a'.repeat(50) + ' end', 10), 'aaaaaaaaaa');
eq('slug: no usable chars -> empty', slugify('日本語 ??? ---'), '');

// --- issueBranchName -------------------------------------------------------
eq('branch name: number + slug', issueBranchName({ number: 42, title: 'Fix the bug' }), '42-fix-the-bug');
eq('branch name: number only when title unusable', issueBranchName({ number: 7, title: '???' }), '7');

// --- withIssueClose --------------------------------------------------------
eq('link: appends Closes to a body', withIssueClose('Some body', 42), 'Some body\n\nCloses #42');
eq('link: empty body -> just the closer', withIssueClose('', 42), 'Closes #42');
eq('link: no issue -> body unchanged', withIssueClose('Body', ''), 'Body');
eq('link: already references the issue -> unchanged', withIssueClose('Fixes #42 already', 42), 'Fixes #42 already');
eq('link: substring number is not a match', withIssueClose('touches #420', 42), 'touches #420\n\nCloses #42');

// --- relAge ----------------------------------------------------------------
eq('age: invalid -> empty', relAge('not-a-date'), '');
eq('age: seconds ago -> now', relAge(new Date(Date.now() - 5 * 1000).toISOString()), 'now');
eq('age: minutes', relAge(new Date(Date.now() - 5 * 60 * 1000).toISOString()), '5m');
eq('age: days', relAge(new Date(Date.now() - 3 * 86400 * 1000).toISOString()), '3d');

// --- issueRow --------------------------------------------------------------
const row = issueRow({
  number: 12,
  title: 'Do a thing',
  labels: [{ name: 'bug' }, { name: 'p1' }],
  assignees: [{ login: 'alice' }],
  updatedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
});
eq('row: number cell', row.num, '#12');
eq('row: labels joined', row.labels, 'bug,p1');
eq('row: assignee', row.who, 'alice');
eq('row: age hours', row.age, '2h');
eq('row: no assignee -> dash', issueRow({ number: 1, title: 't', labels: [], assignees: [] }).who, '—');

// --- scrollTop (viewport paging) -------------------------------------------
// per = rows that fit on screen; top = current first visible index.
eq('scroll: everything fits -> top 0', scrollTop(4, 0, 10, 5), 0);
eq('scroll: selection within window -> unchanged', scrollTop(3, 0, 5, 20), 0);
eq('scroll: selection below window -> pull down', scrollTop(7, 0, 5, 20), 3); // 7-5+1
eq('scroll: selection above window -> pull up', scrollTop(2, 10, 5, 20), 2);
eq('scroll: clamps to end (no empty space past end)', scrollTop(19, 0, 5, 20), 15);
eq('scroll: last item, small list', scrollTop(19, 14, 5, 20), 15);
eq('scroll: page jump keeps window valid', scrollTop(10, 0, 5, 20), 6);

// --- issuesPerPage (page size vs terminal fit) -----------------------------
// A fixed page size is honoured up to what the terminal can fit; 0 = auto/fill.
eq('perPage: fixed size 1', issuesPerPage(1), 1);
eq('perPage: fixed size 2', issuesPerPage(2), 2);
ok('perPage: auto fills at least 3', issuesPerPage(0) >= 3);
ok('perPage: a small page never exceeds auto', issuesPerPage(1) <= issuesPerPage(0));
ok('perPage: huge override caps to the terminal fit', issuesPerPage(100000) === issuesPerPage(0));

// --- renderIssues ----------------------------------------------------------
const table = renderIssues([row]);
ok('table: has a header row', /#\s+TITLE\s+LABELS\s+WHO\s+AGE/.test(table[0]));
ok('table: shows the issue number', table.some((l) => l.includes('#12')));
ok('table: shows the title', table.some((l) => l.includes('Do a thing')));

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
