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

/** Replace all children of `parent` with the given nodes. */
export function replaceChildren(parent: Element, ...children: readonly (Node | string)[]): void {
  parent.replaceChildren(...children);
}

/** Query an element that the app requires; fails loudly on broken markup. */
export function mustFind<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`Required element not found: ${selector}`);
  return found;
}

/** `requestAnimationFrame` as a promise (one frame). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** A debounced version of a function (trailing edge only). */
export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  delay: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
