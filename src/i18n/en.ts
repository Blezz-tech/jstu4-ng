import { formatSymbol, type Messages } from './types';

export const en: Messages = {
  appTitle: 'Turing machine emulator in 4-tuples',
  program: 'Program',
  tape: 'Tape',

  log: {
    ready: 'Ready to run: Ctrl+Enter',
    finished: 'The machine has successfully finished its work',
    warningSourceAltered: 'Warning: the source data was overwritten or modified',
    warningMisposition: 'Warning: the head should stop right after the result',
    convertedToTu4: 'The program was converted to the TU4 format',
    copied: 'Copied to clipboard',
    restoredDraft: 'The last program was restored',
  },

  error: {
    parseError: (text) => `Could not parse “${text}”`,
    programIsEmpty: 'The program is empty',
    ambiguousCommand: (q, a) =>
      `Ambiguous transition for state “${q}” and symbol “${formatSymbol(a)}”`,
    targetStateDoesNotExist: (w) => `Target state “${w}” does not exist`,
    initialStateDoesNotExist: (q) => `Initial state “${q}” does not exist`,
    headIsOutOfTape: 'The head is out of the tape (left border)',
    noSuchCommand: (q, a) =>
      `Transition is undefined for state “${q}” and symbol “${formatSymbol(a)}”`,
    tooManyStates: 'The program has more than 256 states, which the TU4 format cannot express',
  },

  stats: ({ commandsCount, initialDataLength, maxDataLength, operationsCount }) =>
    `Transitions: ${commandsCount}. Source length: ${initialDataLength}. ` +
    `Cells used: ${maxDataLength}. Steps performed: ${operationsCount}`,

  controls: {
    help: 'Help (F1)',
    start: 'Start',
    step: 'Step',
    quick: 'Quick',
    slow: 'Slower',
    backToEdit: 'Back to edit',
    toTu4: 'To TU4',
    unmark: 'Unmark',
    copy: 'Copy',
    theme: 'Toggle theme',
    language: 'Switch language',
  },

  hints: {
    start: 'Parse the program and run it (Ctrl+Enter)',
    step: 'Perform the next step (Space)',
    quick: 'Quick run; press again to speed up (Enter)',
    slow: 'Slow the quick run down',
    backToEdit: 'Stop the machine and return to editing (Esc)',
    toTu4: 'Replace state names with hexadecimal numbers 00–FF',
    unmark: 'Clear the marks from executed commands',
    copy: 'Copy the program to the clipboard',
    editProgram: 'Program: q,a,v,q′. Ctrl+Enter — run',
    editTape: 'Tape: source data. Enter — run',
  },

  shortcuts: {
    run: 'Ctrl+Enter — run the program',
    quickToggle: 'Enter or Ctrl+Enter — toggle quick run',
    step: 'Space — perform one step',
    backToEdit: 'Esc — return to editing',
  },

  a11y: {
    tapeLabel: 'Source data on the tape',
    programLabel: 'Program text',
    programViewLabel: 'Executing program',
    tapeViewLabel: 'Tape during execution',
    logLabel: 'Emulator messages',
    currentCell: 'Current cell',
  },

  help: {
    title: 'Turing machine emulator in 4-tuples',
    back: 'Back to program',
    sections: [
      {
        title: 'About',
        blocks: [
          {
            kind: 'p',
            text:
              'This interactive textbook is intended for students studying the theory of ' +
              'algorithms. The application is an interpreter for 4-tuple Turing machine programs.',
          },
          {
            kind: 'p',
            text:
              '© Alexey Dubinin. The application is available on GitHub: github.com/lxyd/jstu4. ' +
              'It is distributed under the terms of the MIT License.',
          },
        ],
      },
      {
        title: 'Reference',
        blocks: [
          {
            kind: 'p',
            text:
              'Command format: q,a,v,q′ — current state, the symbol seen on the tape, ' +
              'the action (a symbol to write or a command) and the new state.',
          },
          {
            kind: 'list',
            items: [
              '> — move the head right;',
              '< — move the head left;',
              '= — stay in place;',
              '# — stop the machine.',
            ],
          },
          {
            kind: 'p',
            text:
              'Several commands may be written on one line separated by whitespace. ' +
              'C-style (//) and shell-style (#) comments are supported — but there must be at ' +
              'least one space or line break between a command and a comment.',
          },
          {
            kind: 'p',
            text:
              'Named states are supported; names consisting of digits only are interpreted as ' +
              'numbers (01 and 1 are the same state). The initial state must be named 0.',
          },
          {
            kind: 'p',
            text:
              'Executed commands are marked with colour; the “Unmark” button clears the marks. ' +
              'The tape is limited at the left edge and is not padded with spaces automatically.',
          },
        ],
      },
      {
        title: 'Buttons and hotkeys',
        blocks: [
          {
            kind: 'list',
            items: [
              '“Start” — parse and run the program (Ctrl+Enter, or Enter in the tape field);',
              '“Step” — perform the next step (Space);',
              '“Quick” — automatic execution; press again to speed up (Enter);',
              '“Back to edit” — stop the machine and return to editing (Esc);',
              '“To TU4” — replace state names with hexadecimal numbers 00–FF.',
            ],
          },
        ],
      },
      {
        title: 'Example: swap 0 and 1',
        blocks: [
          {
            kind: 'code',
            lines: [
              '00, ,<,rep',
              'rep,0,1,mov  rep,1,0,mov  rep, ,>,fin  // rewrite the cell',
              'mov,0,<,rep  mov,1,<,rep               // step left',
              'fin,0,>,fin  fin,1,>,fin  fin, ,#,fin  // move to the end',
            ],
          },
        ],
      },
    ],
  },
};
