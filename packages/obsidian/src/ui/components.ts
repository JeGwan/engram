/**
 * Shared UI helpers — pure DOM, no framework.
 * Uses Obsidian CSS variables for theming.
 */
import { sanitizeHTMLToDom } from 'obsidian';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (HTMLElement | string)[]
): HTMLElementTagNameMap[K] {
  const elem = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') elem.className = v;
      else if (k === 'text') elem.textContent = v;
      else elem.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') elem.appendText(child);
      else elem.appendChild(child);
    }
  }
  return elem;
}

export function createStatCard(label: string, value: number | string, icon?: string): HTMLElement {
  const card = el('div', { class: 'engram-stat-card' });
  if (icon) {
    const iconEl = el('div', { class: 'engram-stat-icon', text: icon });
    card.appendChild(iconEl);
  }
  const valueEl = el('div', { class: 'engram-stat-value' });
  valueEl.dataset.target = String(value);
  valueEl.textContent = '0';
  card.appendChild(valueEl);
  card.appendChild(el('div', { class: 'engram-stat-label', text: label }));
  return card;
}

export function animateCounters(container: HTMLElement): void {
  const counters = container.querySelectorAll<HTMLElement>('.engram-stat-value');
  counters.forEach(counter => {
    const target = parseInt(counter.dataset.target ?? '0', 10);
    if (isNaN(target) || target === 0) {
      counter.textContent = '0';
      return;
    }
    const duration = 600;
    const start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      counter.textContent = String(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function createSearchInput(placeholder: string, onSearch: (q: string) => void): HTMLElement {
  const wrapper = el('div', { class: 'engram-search-wrapper' });
  const input = el('input', { class: 'engram-search-input', type: 'text', placeholder }) as HTMLInputElement;

  let debounceTimer: ReturnType<typeof setTimeout>;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => onSearch(input.value.trim()), 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceTimer);
      onSearch(input.value.trim());
    }
  });

  wrapper.appendChild(input);
  return wrapper;
}

export function createResultCard(opts: {
  title: string;
  path: string;
  snippet?: string;
  score?: number;
  tags?: string;
  onClick?: () => void;
}): HTMLElement {
  const card = el('div', { class: 'engram-result-card' });
  if (opts.onClick) {
    card.addEventListener('click', opts.onClick);
    card.style.cursor = 'pointer';
  }

  const header = el('div', { class: 'engram-result-header' });
  header.appendChild(el('span', { class: 'engram-result-title', text: opts.title }));
  if (opts.score != null) {
    const pct = Math.round(opts.score * 100);
    header.appendChild(el('span', { class: 'engram-result-score', text: `${pct}%` }));
  }
  card.appendChild(header);

  card.appendChild(el('div', { class: 'engram-result-path', text: opts.path }));

  if (opts.snippet) {
    const snippetEl = el('div', { class: 'engram-result-snippet' });
    snippetEl.appendChild(sanitizeHTMLToDom(opts.snippet));
    card.appendChild(snippetEl);
  }

  if (opts.tags) {
    const tagsEl = el('div', { class: 'engram-result-tags' });
    try {
      const tagArr = JSON.parse(opts.tags);
      if (Array.isArray(tagArr)) {
        tagArr.slice(0, 5).forEach((t: string) => {
          tagsEl.appendChild(el('span', { class: 'engram-tag', text: t }));
        });
      }
    } catch { /* ignore */ }
    card.appendChild(tagsEl);
  }

  return card;
}

export function createDistributionBar(items: { name: string; count: number }[], total: number): HTMLElement {
  const container = el('div', { class: 'engram-distribution' });

  for (const item of items.slice(0, 10)) {
    const row = el('div', { class: 'engram-dist-row' });
    row.appendChild(el('span', { class: 'engram-dist-label', text: item.name || '(root)' }));

    const barWrapper = el('div', { class: 'engram-dist-bar-wrapper' });
    const bar = el('div', { class: 'engram-dist-bar' });
    const pct = total > 0 ? (item.count / total) * 100 : 0;
    bar.style.width = `${pct}%`;
    barWrapper.appendChild(bar);
    row.appendChild(barWrapper);

    row.appendChild(el('span', { class: 'engram-dist-count', text: String(item.count) }));
    container.appendChild(row);
  }

  return container;
}

export function createEmptyState(message: string): HTMLElement {
  return el('div', { class: 'engram-empty-state', text: message });
}

export function createLoadingSpinner(): HTMLElement {
  const wrapper = el('div', { class: 'engram-loading' });
  wrapper.appendChild(el('div', { class: 'engram-spinner' }));
  return wrapper;
}

export function createSelect(options: string[], onChange: (val: string) => void): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'engram-select dropdown';
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt;
    option.text = opt || '(all)';
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}
