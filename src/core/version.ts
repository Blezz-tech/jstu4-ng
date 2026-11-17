declare const __APP_VERSION__: string;

/**
 * Semantic version (SemVer 2.0.0) injected from `package.json` at build time.
 * Displayed in the page header as `v${TM_VERSION}`.
 */
export const TM_VERSION: string = __APP_VERSION__;
