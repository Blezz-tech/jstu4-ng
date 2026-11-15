// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../src/ui/clipboard';

describe('copyTextToClipboard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('returns false without touching clipboard when text is empty', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    expect(await copyTextToClipboard('')).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    expect(await copyTextToClipboard('0, ,#,0')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('0, ,#,0');
  });

  it('falls back to fallbackField + execCommand when Clipboard API rejects', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });

    const editable = document.createElement('textarea');
    editable.value = '0, ,#,0';
    document.body.append(editable);

    expect(await copyTextToClipboard('0, ,#,0', editable)).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(editable.selectionStart).toBe(editable.value.length);

    const readonlyField = document.createElement('textarea');
    readonlyField.value = '00, ,#,00';
    readonlyField.readOnly = true;
    document.body.append(readonlyField);

    expect(await copyTextToClipboard('00, ,#,00', readonlyField)).toBe(true);
    expect(readonlyField.selectionStart).toBe(0);
  });

  it('falls back to a temporary textarea when no fallbackField is provided', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });

    expect(await copyTextToClipboard('hello')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  it('returns false gracefully when fallback execCommand throws', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => {
        throw new Error('execCommand blocked');
      }),
      configurable: true,
    });

    expect(await copyTextToClipboard('hello')).toBe(false);
    expect(document.body.querySelector('textarea')).toBeNull();
  });
});
