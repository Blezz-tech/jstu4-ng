/**
 * Copy text to the system clipboard with a fallback for non-secure origins
 * (such as `file://`) and older browsers.
 */
export async function copyTextToClipboard(
  text: string,
  fallbackField?: HTMLInputElement | HTMLTextAreaElement,
): Promise<boolean> {
  if (text === '') return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      if (fallbackField !== undefined) {
        fallbackField.focus();
        fallbackField.select();
        const copied = document.execCommand('copy');
        const caret = fallbackField.readOnly ? 0 : fallbackField.value.length;
        fallbackField.setSelectionRange(caret, caret);
        return copied;
      }

      const temp = document.createElement('textarea');
      temp.value = text;
      temp.setAttribute('readonly', '');
      temp.style.position = 'fixed';
      temp.style.opacity = '0';
      document.body.append(temp);
      try {
        temp.select();
        return document.execCommand('copy');
      } finally {
        temp.remove();
      }
    } catch {
      return false;
    }
  }
}
