import type { EngramEngine } from '../engine';

export abstract class BaseRenderer {
  protected container: HTMLElement | null = null;
  protected engine: EngramEngine;

  constructor(engine: EngramEngine) {
    this.engine = engine;
  }

  abstract render(container: HTMLElement): void;

  destroy(): void {
    if (this.container) {
      this.container.empty();
      this.container = null;
    }
  }
}
