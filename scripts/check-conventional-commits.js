import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Allowed Conventional Commits 1.0.0 commit types (Angular / Conventional standard).
 * @see https://www.conventionalcommits.org/en/v1.0.0/
 */
export const CONVENTIONAL_TYPES = Object.freeze([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]);

/** Official SemVer 2.0.0 validation pattern (https://semver.org/). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const TYPES_PATTERN = CONVENTIONAL_TYPES.join('|');
const HEADER_RE = new RegExp(
  `^(?<type>${TYPES_PATTERN})(?:\\((?<scope>[a-z0-9]+(?:[._/-][a-z0-9]+)*)\\))?(?<breaking>!)?(?<colon>:) (?<description>\\S.*)$`,
);
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:\s+\S/m;
const MERGE_SUBJECT_RE = /^Merge (?:pull request #\d+|branch |remote-tracking branch |tag )/;

/**
 * Strip Git comment lines (starting with `#`) and trailing cut-line scissors.
 * @param {string} raw
 */
export function stripGitComments(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const cutIndex = normalized.indexOf('\n# ------------------------ >8 ------------------------\n');
  const relevant = cutIndex >= 0 ? normalized.slice(0, cutIndex) : normalized;
  return relevant
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
}

/**
 * Parse a commit message or PR title against Conventional Commits 1.0.0.
 * @param {string} message
 * @param {{ allowMerge?: boolean }} [options]
 */
export function validateConventionalCommit(message, options = {}) {
  const { allowMerge = true } = options;
  const cleaned = stripGitComments(message);
  const [header = '', ...rest] = cleaned.split('\n');
  const trimmedHeader = header.trim();

  if (trimmedHeader === '') {
    return { ok: false, reason: 'Commit message header is empty.' };
  }

  if (allowMerge && MERGE_SUBJECT_RE.test(trimmedHeader)) {
    return {
      ok: true,
      merge: true,
      type: null,
      scope: null,
      breaking: false,
      description: trimmedHeader,
      bump: 'none',
    };
  }

  const match = HEADER_RE.exec(trimmedHeader);
  if (match === null || match.groups === undefined) {
    return {
      ok: false,
      reason: `Header "${trimmedHeader}" does not match Conventional Commits 1.0.0 (<type>[optional (<scope>)][!]: <description>). Allowed types: ${CONVENTIONAL_TYPES.join(', ')}.`,
    };
  }

  const bodyAndFooters = rest.join('\n').trim();
  const hasBlankSeparator = rest.length === 0 || rest[0]?.trim() === '';
  if (bodyAndFooters !== '' && !hasBlankSeparator) {
    return {
      ok: false,
      reason: `Body/footer must be separated from header "${trimmedHeader}" by a blank line.`,
    };
  }

  const type = match.groups['type'] ?? '';
  const scope = match.groups['scope'] ?? null;
  const description = match.groups['description'] ?? '';
  const breaking = Boolean(match.groups['breaking']) || BREAKING_FOOTER_RE.test(bodyAndFooters);

  let bump = 'none';
  if (breaking) bump = 'major';
  else if (type === 'feat') bump = 'minor';
  else if (type === 'fix' || type === 'perf' || type === 'revert') bump = 'patch';

  return { ok: true, merge: false, type, scope, breaking, description, bump };
}

/**
 * Validate git commits in `range` (excluding merge commits).
 * @param {string} range
 */
function readGitCommits(range) {
  const args =
    range === ''
      ? ['log', '-1', '--format=%H%x1f%B%x1e']
      : ['log', '--no-merges', '--format=%H%x1f%B%x1e', range];
  const output = execFileSync('git', args, { encoding: 'utf8' });
  return output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const sep = entry.indexOf('\x1f');
      return {
        sha: sep >= 0 ? entry.slice(0, sep).trim() : '',
        message: sep >= 0 ? entry.slice(sep + 1) : entry,
      };
    });
}

function runCli(argv) {
  const [flag = '', value = ''] = argv;
  const failures = [];

  if (flag === '--title') {
    const res = validateConventionalCommit(value, { allowMerge: false });
    if (!res.ok) failures.push({ label: 'PR title', reason: res.reason });
  } else if (flag === '--message') {
    const res = validateConventionalCommit(value, { allowMerge: true });
    if (!res.ok) failures.push({ label: 'message', reason: res.reason });
  } else if (flag === '--file') {
    if (value === '') {
      process.stderr.write('Usage: check-conventional-commits.js --file <path>\n');
      process.exit(2);
    }
    const content = readFileSync(value, 'utf8');
    const res = validateConventionalCommit(content, { allowMerge: true });
    if (!res.ok) failures.push({ label: value, reason: res.reason });
  } else if (flag === '--range' || flag === '') {
    const range = flag === '--range' ? value : '';
    const commits = readGitCommits(range);
    if (commits.length === 0) {
      process.stdout.write('No non-merge commits found to check.\n');
      return;
    }
    for (const commit of commits) {
      const res = validateConventionalCommit(commit.message, { allowMerge: true });
      if (!res.ok) {
        failures.push({ label: commit.sha.slice(0, 7) || 'HEAD', reason: res.reason });
      }
    }
    if (failures.length === 0) {
      process.stdout.write(
        `Conventional Commits OK (${commits.length} commit${commits.length === 1 ? '' : 's'} checked).\n`,
      );
      return;
    }
  } else {
    process.stderr.write(
      'Usage: check-conventional-commits.js [--title <text> | --message <text> | --file <path> | --range <base>..<head>]\n',
    );
    process.exit(2);
  }

  if (failures.length === 0) {
    process.stdout.write('Conventional Commits OK.\n');
    return;
  }

  process.stderr.write('Conventional Commits check failed:\n');
  for (const failure of failures) {
    process.stderr.write(`  - [${failure.label}] ${failure.reason}\n`);
  }
  process.stderr.write(
    '\nExpected format (https://www.conventionalcommits.org/en/v1.0.0/):\n' +
      '  feat(scope): short description\n' +
      '  fix: resolve edge case\n' +
      '  feat!: breaking change description\n',
  );
  process.exit(1);
}

const isMainModule =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2));
}
