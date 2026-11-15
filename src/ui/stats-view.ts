import type { I18n } from '../i18n';
import { el } from './dom';

export interface RunStats {
  commandsCount: number;
  initialDataLength: number;
  maxDataLength: number;
  operationsCount: number;
}

export interface StatsView {
  set(stats: RunStats): void;
  updateProgress(operationsCount: number, maxDataLength: number): void;
  refreshLabels(): void;
  dispose(): void;
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
export function createStatsView(container: HTMLElement, i18n: I18n): StatsView {
  let stats: RunStats | null = null;
  let nodes: StatRowNodes[] | null = null;

  const render = (refreshLabels: boolean): void => {
    if (stats === null) return;
    const values: readonly [number, number, number, number] = [
      stats.commandsCount,
      stats.initialDataLength,
      stats.maxDataLength,
      stats.operationsCount,
    ];

    if (nodes === null || !container.contains(nodes[0]?.row ?? null)) {
      const fragment = document.createDocumentFragment();
      const created: StatRowNodes[] = [];
      STAT_LABEL_KEYS.forEach((key, index) => {
        if (index > 0) fragment.appendChild(document.createTextNode('\n'));
        const val = values[index] ?? 0;
        const label = el('span', { class: 'stat-row__label' }, `${i18n.t(key)}: `);
        const value = el('strong', { class: 'stat-row__value' }, i18n.formatNumber(val));
        const row = el('div', { class: 'stat-row' }, label, value);
        fragment.appendChild(row);
        created.push({ row, label, value, lastValue: val });
      });
      container.replaceChildren(fragment);
      nodes = created;
      return;
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const key = STAT_LABEL_KEYS[i];
      const val = values[i];
      if (node === undefined || key === undefined || val === undefined) continue;
      if (refreshLabels) {
        node.label.textContent = `${i18n.t(key)}: `;
        node.lastValue = val;
        node.value.textContent = i18n.formatNumber(val);
      } else if (node.lastValue !== val) {
        node.lastValue = val;
        node.value.textContent = i18n.formatNumber(val);
      }
    }
  };

  return {
    set(next) {
      stats = next;
      render(false);
    },
    updateProgress(operationsCount, maxDataLength) {
      if (stats === null) return;
      stats.operationsCount = operationsCount;
      stats.maxDataLength = maxDataLength;
      render(false);
    },
    refreshLabels() {
      if (stats !== null) render(true);
    },
    dispose() {
      nodes = null;
    },
  };
}
