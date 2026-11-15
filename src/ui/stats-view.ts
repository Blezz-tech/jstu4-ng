import type { I18n } from '../i18n';
import { el } from './dom';

export interface RunStats {
  commandsCount: number;
  initialDataLength: number;
  maxDataLength: number;
  operationsCount: number;
}

const STAT_LABEL_KEYS = [
  'stats.commands',
  'stats.initialLength',
  'stats.cellsUsed',
  'stats.operations',
] as const;

interface StatRowNodes {
  readonly row: HTMLElement;
  readonly label: HTMLElement;
  readonly value: HTMLElement;
  lastValue: number;
}

/**
 * Incremental DOM renderer for the side-panel execution metrics card (`#stats`).
 * Reuses its four `.stat-row` nodes across steps and locale switches, updating
 * only numeric values that actually changed.
 */
export class StatsView {
  private stats: RunStats | null = null;
  private nodes: StatRowNodes[] | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly i18n: I18n,
  ) {}

  set(stats: RunStats): void {
    this.stats = stats;
    this.render(false);
  }

  updateProgress(operationsCount: number, maxDataLength: number): void {
    if (this.stats === null) return;
    this.stats.operationsCount = operationsCount;
    this.stats.maxDataLength = maxDataLength;
    this.render(false);
  }

  refreshLabels(): void {
    if (this.stats !== null) this.render(true);
  }

  dispose(): void {
    this.nodes = null;
  }

  private render(refreshLabels: boolean): void {
    const stats = this.stats;
    if (stats === null) return;
    const values: readonly [number, number, number, number] = [
      stats.commandsCount,
      stats.initialDataLength,
      stats.maxDataLength,
      stats.operationsCount,
    ];

    if (this.nodes === null || !this.container.contains(this.nodes[0]?.row ?? null)) {
      const fragment = document.createDocumentFragment();
      const nodes: StatRowNodes[] = [];
      STAT_LABEL_KEYS.forEach((key, index) => {
        if (index > 0) fragment.appendChild(document.createTextNode('\n'));
        const val = values[index] ?? 0;
        const label = el('span', { class: 'stat-row__label' }, `${this.i18n.t(key)}: `);
        const value = el('strong', { class: 'stat-row__value' }, this.i18n.formatNumber(val));
        const row = el('div', { class: 'stat-row' }, label, value);
        fragment.appendChild(row);
        nodes.push({ row, label, value, lastValue: val });
      });
      this.container.replaceChildren(fragment);
      this.nodes = nodes;
      return;
    }

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const key = STAT_LABEL_KEYS[i];
      const val = values[i];
      if (node === undefined || key === undefined || val === undefined) continue;
      if (refreshLabels) {
        node.label.textContent = `${this.i18n.t(key)}: `;
        node.lastValue = val;
        node.value.textContent = this.i18n.formatNumber(val);
      } else if (node.lastValue !== val) {
        node.lastValue = val;
        node.value.textContent = this.i18n.formatNumber(val);
      }
    }
  }
}
