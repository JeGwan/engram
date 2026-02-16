import { BaseRenderer } from './base-renderer';
import { el, createEmptyState } from './components';

interface TableInfo {
  name: string;
  sql: string;
  columns: { name: string; type: string; notnull: boolean; pk: boolean }[];
  rowCount: number;
}

export class DbExplorerRenderer extends BaseRenderer {
  private contentArea: HTMLElement | null = null;
  private selectedTable = '';
  private currentOffset = 0;
  private currentSort = '';
  private currentOrder = 'ASC';
  private pageSize = 50;

  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    const tables = this.engine.getTables() as TableInfo[];

    if (tables.length === 0) {
      container.appendChild(createEmptyState('No tables found. Index your vault first.'));
      return;
    }

    const layout = el('div', { class: 'engram-db-layout' });

    const sidebar = el('div', { class: 'engram-db-sidebar' });
    sidebar.appendChild(el('h4', { text: 'Tables' }));

    for (const t of tables) {
      const item = el('div', {
        class: 'engram-db-table-item',
        text: `${t.name} (${t.rowCount})`,
      });
      item.addEventListener('click', () => {
        this.selectedTable = t.name;
        this.currentOffset = 0;
        this.currentSort = '';
        sidebar.querySelectorAll('.engram-db-table-item').forEach(el =>
          el.removeClass('engram-db-table-active'),
        );
        item.addClass('engram-db-table-active');
        this.renderTable();
      });
      sidebar.appendChild(item);
    }

    layout.appendChild(sidebar);

    this.contentArea = el('div', { class: 'engram-db-content' });
    this.contentArea.appendChild(createEmptyState('Select a table'));
    layout.appendChild(this.contentArea);

    container.appendChild(layout);
  }

  private renderTable(): void {
    if (!this.contentArea || !this.selectedTable) return;
    this.contentArea.empty();

    const data = this.engine.getTableRows(this.selectedTable, {
      limit: this.pageSize,
      offset: this.currentOffset,
      sort: this.currentSort,
      order: this.currentOrder,
    });

    if (data.rows.length === 0) {
      this.contentArea.appendChild(createEmptyState('No rows'));
      return;
    }

    const paginationTop = el('div', { class: 'engram-db-pagination' });
    const from = this.currentOffset + 1;
    const to = Math.min(this.currentOffset + this.pageSize, data.total);
    paginationTop.appendChild(el('span', { text: `${from}-${to} of ${data.total}` }));

    const btnGroup = el('div', { class: 'engram-db-btn-group' });
    if (this.currentOffset > 0) {
      const prevBtn = el('button', { class: 'engram-btn engram-btn-sm', text: '← Prev' });
      prevBtn.addEventListener('click', () => {
        this.currentOffset = Math.max(0, this.currentOffset - this.pageSize);
        this.renderTable();
      });
      btnGroup.appendChild(prevBtn);
    }
    if (this.currentOffset + this.pageSize < data.total) {
      const nextBtn = el('button', { class: 'engram-btn engram-btn-sm', text: 'Next →' });
      nextBtn.addEventListener('click', () => {
        this.currentOffset += this.pageSize;
        this.renderTable();
      });
      btnGroup.appendChild(nextBtn);
    }
    paginationTop.appendChild(btnGroup);
    this.contentArea.appendChild(paginationTop);

    const tableWrapper = el('div', { class: 'engram-db-table-wrapper' });
    const table = el('table', { class: 'engram-db-table' });

    const thead = el('thead');
    const headerRow = el('tr');
    for (const col of data.columns) {
      const th = el('th', { text: col });
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        if (this.currentSort === col) {
          this.currentOrder = this.currentOrder === 'ASC' ? 'desc' : 'ASC';
        } else {
          this.currentSort = col;
          this.currentOrder = 'ASC';
        }
        this.currentOffset = 0;
        this.renderTable();
      });
      if (this.currentSort === col) {
        th.textContent += this.currentOrder === 'ASC' ? ' ▲' : ' ▼';
      }
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const row of data.rows) {
      const tr = el('tr');
      for (const col of data.columns) {
        const val = row[col];
        const td = el('td');
        td.textContent = val == null ? 'NULL' : String(val);
        if (typeof val === 'string' && val.length > 100) {
          td.title = val;
          td.textContent = val.slice(0, 100) + '...';
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    this.contentArea.appendChild(tableWrapper);
  }

  destroy(): void {
    this.contentArea = null;
    super.destroy();
  }
}
