/** Languages shipped with the app. */
export const LANGS = ['ru', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = 'ru';

/**
 * Render a tape symbol for humans. The space is a real symbol in TM
 * programs but is invisible in a message, so it is shown as the
 * "open box" glyph (U+2423).
 */
export function formatSymbol(symbol: string): string {
  return symbol === ' ' ? '\u2423' : symbol;
}

export interface Messages {
  readonly appTitle: string;
  readonly program: string;
  readonly tape: string;

  /** Log / status messages. */
  readonly log: {
    readonly ready: string;
    readonly finished: string;
    readonly warningSourceAltered: string;
    readonly warningMisposition: string;
    readonly convertedToTu4: string;
    readonly copied: string;
    readonly restoredDraft: string;
  };

  /** Error messages for compile and runtime errors. */
  readonly error: {
    readonly parseError: (text: string) => string;
    readonly programIsEmpty: string;
    readonly ambiguousCommand: (q: string, a: string) => string;
    readonly targetStateDoesNotExist: (w: string) => string;
    readonly initialStateDoesNotExist: (q: string) => string;
    readonly headIsOutOfTape: string;
    readonly noSuchCommand: (q: string, a: string) => string;
    readonly tooManyStates: string;
  };

  readonly stats: (values: {
    readonly commandsCount: number;
    readonly initialDataLength: number;
    readonly maxDataLength: number;
    readonly operationsCount: number;
  }) => string;

  readonly controls: {
    readonly help: string;
    readonly start: string;
    readonly step: string;
    readonly quick: string;
    readonly slow: string;
    readonly backToEdit: string;
    readonly toTu4: string;
    readonly unmark: string;
    readonly copy: string;
    readonly theme: string;
    readonly language: string;
  };

  readonly hints: {
    readonly start: string;
    readonly step: string;
    readonly quick: string;
    readonly slow: string;
    readonly backToEdit: string;
    readonly toTu4: string;
    readonly unmark: string;
    readonly copy: string;
    readonly editProgram: string;
    readonly editTape: string;
  };

  readonly shortcuts: {
    readonly run: string;
    readonly quickToggle: string;
    readonly step: string;
    readonly backToEdit: string;
  };

  readonly a11y: {
    readonly tapeLabel: string;
    readonly programLabel: string;
    readonly programViewLabel: string;
    readonly tapeViewLabel: string;
    readonly logLabel: string;
    readonly currentCell: string;
  };

  readonly help: HelpContent;
}

export interface HelpSection {
  readonly title: string;
  readonly blocks: readonly HelpBlock[];
}

export type HelpBlock =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | { readonly kind: 'code'; readonly lines: readonly string[] };

export interface HelpContent {
  readonly title: string;
  readonly back: string;
  readonly sections: readonly HelpSection[];
}
