// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { svgIcon } from '../src/ui/dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('svgIcon', () => {
  it('builds stroke-based SVG icons from path d strings', () => {
    const icon = svgIcon(['M3 6h18', 'M10 11v6'], 16);

    expect(icon.namespaceURI).toBe(SVG_NS);
    expect(icon.tagName).toBe('svg');
    expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(icon.getAttribute('width')).toBe('16');
    expect(icon.getAttribute('height')).toBe('16');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('focusable')).toBe('false');

    const paths = Array.from(icon.children);
    expect(paths).toHaveLength(2);
    expect(paths[0]?.tagName).toBe('path');
    expect(paths[0]?.getAttribute('d')).toBe('M3 6h18');
    expect(paths[0]?.getAttribute('stroke')).toBe('currentColor');
    expect(paths[0]?.getAttribute('fill')).toBe('none');
  });
});
