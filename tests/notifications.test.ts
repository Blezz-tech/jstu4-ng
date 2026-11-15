// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from '../src/i18n';
import { createNotificationLog } from '../src/ui/notifications';

describe('NotificationLog', () => {
  it('renders localized messages, reacts to locale switches, clears cleanly, and disposes', () => {
    const element = document.createElement('div');
    const i18n = createI18n('ru');
    const onChange = vi.fn();
    const log = createNotificationLog({ element, i18n, onChange });

    expect(log.currentKind).toBeNull();

    log.show('info', (t) => t.t('log.snapshotSaved'));
    expect(element.textContent).toBe('Снимок программы сохранён');
    expect(element.dataset.kind).toBe('info');
    expect(log.currentKind).toBe('info');
    expect(onChange).toHaveBeenLastCalledWith('info');

    // Locale switch automatically re-renders the active message
    i18n.setLocale('en');
    expect(element.textContent).toBe('Program snapshot saved');
    expect(element.dataset.kind).toBe('info');

    // Clear resets text and kind; redundant clear is a no-op
    log.clear();
    expect(element.textContent).toBe('');
    expect(element.dataset.kind).toBe('');
    expect(log.currentKind).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(null);
    const callCountAfterClear = onChange.mock.calls.length;
    log.clear();
    expect(onChange).toHaveBeenCalledTimes(callCountAfterClear);

    // After dispose, locale changes do not re-render
    log.show('warning', (t) => t.t('log.snapshotEmpty'));
    expect(element.textContent).toBe('Nothing to save: program is empty');
    log.dispose();
    i18n.setLocale('ru');
    expect(element.textContent).toBe('Nothing to save: program is empty');
  });
});
