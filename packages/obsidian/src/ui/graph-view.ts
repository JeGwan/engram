import { BaseRenderer } from './base-renderer';
import { el, createSelect, createEmptyState } from './components';
import type { EngramEngine } from '../engine';
import { DataSet } from 'vis-data';
import { Network } from 'vis-network';

export class GraphViewRenderer extends BaseRenderer {
  private network: Network | null = null;
  private graphContainer: HTMLElement | null = null;
  private detailPanel: HTMLElement | null = null;
  private typeFilter = '';
  private relTypeFilter = '';

  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    const controls = el('div', { class: 'engram-graph-controls' });

    const stats = this.engine.getStats();
    const entityTypes = ['', ...stats.entityTypes.map(t => t.type)];
    controls.appendChild(el('label', { text: 'Entity type: ' }));
    controls.appendChild(createSelect(entityTypes, t => {
      this.typeFilter = t;
      this.renderGraph();
    }));

    const refreshBtn = el('button', { class: 'engram-btn', text: 'Refresh' });
    refreshBtn.addEventListener('click', () => this.renderGraph());
    controls.appendChild(refreshBtn);

    container.appendChild(controls);

    this.graphContainer = el('div', { class: 'engram-graph-container' });
    container.appendChild(this.graphContainer);

    this.detailPanel = el('div', { class: 'engram-detail-panel' });
    container.appendChild(this.detailPanel);

    this.renderGraph();
  }

  private renderGraph(): void {
    if (!this.graphContainer) return;

    const data = this.engine.getGraphData(this.typeFilter || undefined, this.relTypeFilter || undefined);

    if (data.nodes.length === 0) {
      this.graphContainer.empty();
      this.graphContainer.appendChild(createEmptyState('No graph data. Run graph extraction first.'));
      return;
    }

    const nodes = new DataSet(data.nodes);
    const edges = new DataSet(data.edges);

    if (this.network) {
      this.network.destroy();
    }

    this.network = new Network(this.graphContainer, { nodes, edges }, {
      nodes: {
        shape: 'dot',
        size: 16,
        font: { size: 12, color: 'var(--text-normal)' },
        borderWidth: 2,
      },
      edges: {
        font: { size: 9, color: 'var(--text-muted)', align: 'middle' },
        arrows: { to: { enabled: true, scaleFactor: 0.5 } },
        color: { color: 'var(--text-faint)', highlight: 'var(--interactive-accent)' },
        smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
      },
      physics: {
        stabilization: { iterations: 150 },
        barnesHut: { gravitationalConstant: -3000, springLength: 150 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 100,
      },
    });

    this.network.once('stabilizationIterationsDone', () => {
      this.network?.setOptions({ physics: { enabled: false } });
    });

    this.network.on('click', (params: any) => {
      if (params.nodes.length > 0) {
        this.showEntityDetail(params.nodes[0]);
      } else {
        this.clearDetail();
      }
    });
  }

  private showEntityDetail(entityId: string): void {
    if (!this.detailPanel) return;
    this.detailPanel.empty();

    const entities = this.engine.searchEntities(entityId);
    const entity = entities.find(e => e.id === entityId);
    if (!entity) return;

    this.detailPanel.appendChild(el('h4', { text: entity.name }));
    this.detailPanel.appendChild(el('div', { class: 'engram-detail-type', text: `Type: ${entity.type}` }));

    if (entity.aliases.length > 0) {
      this.detailPanel.appendChild(el('div', { class: 'engram-detail-aliases', text: `Aliases: ${entity.aliases.join(', ')}` }));
    }

    const rels = this.engine.getEntityRelationships(entityId);
    if (rels.length > 0) {
      this.detailPanel.appendChild(el('h5', { text: `Relationships (${rels.length})` }));
      const relList = el('div', { class: 'engram-detail-list' });
      for (const r of rels.slice(0, 20)) {
        const other = r.sourceId === entityId ? r.targetId : r.sourceId;
        const dir = r.sourceId === entityId ? '→' : '←';
        relList.appendChild(el('div', { class: 'engram-detail-item', text: `${dir} ${r.type} ${other}` }));
      }
      this.detailPanel.appendChild(relList);
    }

    const facts = this.engine.getEntityFacts(entityId);
    if (facts.length > 0) {
      this.detailPanel.appendChild(el('h5', { text: `Facts (${facts.length})` }));
      const factList = el('div', { class: 'engram-detail-list' });
      for (const f of facts.slice(0, 10)) {
        const date = f.recordedAt ? `[${f.recordedAt}] ` : '';
        factList.appendChild(el('div', { class: 'engram-detail-item', text: `${date}${f.type}: ${f.content}` }));
      }
      this.detailPanel.appendChild(factList);
    }
  }

  private clearDetail(): void {
    if (this.detailPanel) this.detailPanel.empty();
  }

  destroy(): void {
    if (this.network) {
      this.network.destroy();
      this.network = null;
    }
    this.graphContainer = null;
    this.detailPanel = null;
    super.destroy();
  }
}
