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

export type SvgShape =
  | string
  | { readonly tag: 'path'; readonly d: string }
  | { readonly tag: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | {
      readonly tag: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | { readonly tag: 'polyline'; readonly points: string }
  | {
      readonly tag: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx?: number;
    };

export interface SvgIconOptions {
  readonly size?: number;
  readonly viewBox?: string;
  readonly strokeWidth?: number;
  readonly className?: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create a stroke-based decorative `<svg>` icon using DOM namespaces (never
 * `innerHTML`). Accepts either shorthand SVG `path` `d` strings or typed shape
 * descriptors (`path`, `circle`, `line`, `polyline`, `rect`).
 */
export function svgIcon(shapes: readonly SvgShape[], options: SvgIconOptions = {}): SVGSVGElement {
  const size = options.size ?? 14;
  const strokeWidth = options.strokeWidth ?? 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', options.viewBox ?? '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (options.className !== undefined && options.className !== '') {
    svg.setAttribute('class', options.className);
  }

  for (const shape of shapes) {
    const tag = typeof shape === 'string' ? 'path' : shape.tag;
    const node = document.createElementNS(SVG_NS, tag);
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', String(strokeWidth));
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');

    if (typeof shape === 'string') {
      node.setAttribute('d', shape);
    } else {
      switch (shape.tag) {
        case 'path':
          node.setAttribute('d', shape.d);
          break;
        case 'circle':
          node.setAttribute('cx', String(shape.cx));
          node.setAttribute('cy', String(shape.cy));
          node.setAttribute('r', String(shape.r));
          break;
        case 'line':
          node.setAttribute('x1', String(shape.x1));
          node.setAttribute('y1', String(shape.y1));
          node.setAttribute('x2', String(shape.x2));
          node.setAttribute('y2', String(shape.y2));
          break;
        case 'polyline':
          node.setAttribute('points', shape.points);
          break;
        case 'rect':
          node.setAttribute('x', String(shape.x));
          node.setAttribute('y', String(shape.y));
          node.setAttribute('width', String(shape.width));
          node.setAttribute('height', String(shape.height));
          if (shape.rx !== undefined) node.setAttribute('rx', String(shape.rx));
          break;
      }
    }

    svg.append(node);
  }

  return svg;
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
