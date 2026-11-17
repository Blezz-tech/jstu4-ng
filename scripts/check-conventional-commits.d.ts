export declare const CONVENTIONAL_TYPES: readonly [
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
];

export declare const SEMVER_RE: RegExp;

export type SemVerBump = 'major' | 'minor' | 'patch' | 'none';

export type ConventionalCommitResult =
  | {
      readonly ok: true;
      readonly merge: boolean;
      readonly type: string | null;
      readonly scope: string | null;
      readonly breaking: boolean;
      readonly description: string;
      readonly bump: SemVerBump;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export declare function stripGitComments(raw: string): string;

export declare function validateConventionalCommit(
  message: string,
  options?: { readonly allowMerge?: boolean },
): ConventionalCommitResult;
