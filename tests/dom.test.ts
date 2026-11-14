// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { svgIcon } from '../src/ui/dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

describe('svgIcon', () => {
  it('builds stroke-based SVG icons from shorthand path strings', () => {
    const icon = svgIcon(['M3 6h18', 'M10 11v6'], { size: 16, className: 'icon-trash' });

    expect(icon.namespaceURI).toBe(SVG_NS);
    expect(icon.tagName).toBe('svg');
    expect(icon.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(icon.getAttribute('width')).toBe('16');
    expect(icon.getAttribute('height')).toBe('16');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('focusable')).toBe('false');
    expect(icon.getAttribute('class')).toBe('icon-trash');

    const paths = Array.from(icon.children);
    expect(paths).toHaveLength(2);
    expect(paths[0]?.tagName).toBe('path');
    expect(paths[0]?.getAttribute('d')).toBe('M3 6h18');
    expect(paths[0]?.getAttribute('stroke')).toBe('currentColor');
    expect(paths[0]?.getAttribute('fill')).toBe('none');
  });

  it('supports typed SVG shape primitives (path, circle, line, polyline, rect)', () => {
    const icon = svgIcon(
      [
        { tag: 'path', d: 'M1 1h5' },
        { tag: 'circle', cx: 12, cy: 12, r: 9 },
        { tag: 'line', x1: 0, y1: 0, x2: 10, y2: 10 },
        { tag: 'polyline', points: '12 7 12 12 15 15' },
        { tag: 'rect', x: 2, y: 3, width: 20, height: 18, rx: 2 },
      ],
      { viewBox: '0 0 32 32', strokeWidth: 1.5 },
    );

    expect(icon.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(icon.children).toHaveLength(5);

    const [path, circle, line, polyline, rect] = Array.from(icon.children);
    expect(path?.getAttribute('d')).toBe('M1 1h5');
    expect(path?.getAttribute('stroke-width')).toBe('1.5');
    expect(circle?.tagName).toBe('circle');
    expect(circle?.getAttribute('r')).toBe('9');
    expect(line?.tagName).toBe('line');
    expect(line?.getAttribute('x2')).toBe('10');
    expect(polyline?.tagName).toBe('polyline');
    expect(polyline?.getAttribute('points')).toBe('12 7 12 12 15 15');
    expect(rect?.tagName).toBe('rect');
    expect(rect?.getAttribute('rx')).toBe('2');
  });
});
