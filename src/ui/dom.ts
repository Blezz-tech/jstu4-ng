/**
 * Tiny DOM helpers.
 *
 * Everything is created with `document.createElement` + `textContent`, never
 * with `innerHTML` on user-provided data: program text and tape symbols come
 * from the user, and the original jQuery version built them by string
 * concatenation (an XSS hazard the rewrite removes at the source).
 */

type Attrs = Record<string, string>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: readonly (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Query an element that the app requires; fails loudly on broken markup. */
export function mustFind<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`Required element not found: ${selector}`);
  return found;
}

export interface DebouncedFn<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/** A debounced version of a function (trailing edge only) with cancellation support. */
export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): DebouncedFn<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delay);
  };
  wrapped.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return wrapped;
}
