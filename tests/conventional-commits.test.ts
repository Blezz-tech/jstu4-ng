import { describe, expect, it } from 'vitest';
import {
  CONVENTIONAL_TYPES,
  SEMVER_RE,
  stripGitComments,
  validateConventionalCommit,
} from '../scripts/check-conventional-commits.js';

describe('Conventional Commits 1.0.0 validator', () => {
  it('accepts all standard types with optional scope and computes SemVer bump', () => {
    for (const type of CONVENTIONAL_TYPES) {
      const res = validateConventionalCommit(`${type}: example change`);
      expect(res.ok, `type "${type}" should be valid`).toBe(true);
    }

    expect(validateConventionalCommit('feat(ui/dialogs): sync close cleanup')).toEqual({
      ok: true,
      merge: false,
      type: 'feat',
      scope: 'ui/dialogs',
      breaking: false,
      description: 'sync close cleanup',
      bump: 'minor',
    });

    expect(validateConventionalCommit('fix(core): clamp tape index')).toMatchObject({
      ok: true,
      type: 'fix',
      scope: 'core',
      breaking: false,
      bump: 'patch',
    });

    expect(validateConventionalCommit('perf: avoid allocations in step loop')).toMatchObject({
      ok: true,
      type: 'perf',
      bump: 'patch',
    });

    expect(validateConventionalCommit('docs(readme): document semver policy')).toMatchObject({
      ok: true,
      type: 'docs',
      bump: 'none',
    });
  });

  it('detects breaking changes via "!" and BREAKING CHANGE / BREAKING-CHANGE footers', () => {
    expect(validateConventionalCommit('feat!: drop legacy format')).toMatchObject({
      ok: true,
      breaking: true,
      bump: 'major',
    });

    expect(validateConventionalCommit('refactor(api)!: rename exports')).toMatchObject({
      ok: true,
      scope: 'api',
      breaking: true,
      bump: 'major',
    });

    const withFooter = 'chore: update storage schema\n\nBREAKING CHANGE: drops v1 keys';
    expect(validateConventionalCommit(withFooter)).toMatchObject({
      ok: true,
      breaking: true,
      bump: 'major',
    });

    const withHyphenFooter = 'fix: adjust parser\n\nBREAKING-CHANGE: rejects tab separators';
    expect(validateConventionalCommit(withHyphenFooter)).toMatchObject({
      ok: true,
      breaking: true,
      bump: 'major',
    });
  });

  it('allows git merge commits only when allowMerge is enabled', () => {
    const mergeMsg = 'Merge pull request #35 from Blezz-tech/arena/fix';
    expect(validateConventionalCommit(mergeMsg, { allowMerge: true })).toMatchObject({
      ok: true,
      merge: true,
      bump: 'none',
    });
    expect(validateConventionalCommit(mergeMsg, { allowMerge: false }).ok).toBe(false);
  });

  it('rejects malformed headers, unknown types, empty scopes/descriptions, and missing blank line', () => {
    const invalid = [
      '',
      '   ',
      'Add feature without prefix',
      'feature: non-standard type',
      'FEAT: uppercase type',
      'feat:missing space after colon',
      'feat:   ',
      'feat(): empty scope',
      'feat(bad scope): spaces in scope',
      'feat(core): header\nbody without blank separator',
    ];
    for (const msg of invalid) {
      expect(validateConventionalCommit(msg).ok, `"${msg}" should be rejected`).toBe(false);
    }
  });

  it('strips git comment lines and cut-line diff before validation', () => {
    const raw = [
      'fix(i18n): update repository attribution',
      '',
      '# Please enter the commit message for your changes.',
      '# ------------------------ >8 ------------------------',
      'diff --git a/README.md b/README.md',
    ].join('\n');

    expect(stripGitComments(raw)).toBe('fix(i18n): update repository attribution');
    expect(validateConventionalCommit(raw)).toMatchObject({
      ok: true,
      type: 'fix',
      scope: 'i18n',
    });
  });
});

describe('SemVer 2.0.0 pattern', () => {
  it('matches valid SemVer strings and rejects invalid ones', () => {
    for (const v of ['0.1.0', '3.0.0', '3.1.0-beta.1', '3.1.0+build.42']) {
      expect(SEMVER_RE.test(v), `"${v}" should be valid SemVer`).toBe(true);
    }
    for (const v of ['3.0', 'v3.0.0', '03.0.0', '3.0.0.1', '']) {
      expect(SEMVER_RE.test(v), `"${v}" should be invalid SemVer`).toBe(false);
    }
  });
});
