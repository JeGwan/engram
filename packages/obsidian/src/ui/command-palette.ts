import { el } from './components';

interface PaletteCommand {
  id: string;
  name: string;
  icon?: string;
  callback: () => void;
}

export class CommandPalette {
  private overlay: HTMLElement | null = null;
  private commands: PaletteCommand[] = [];
  private onClose: (() => void) | null = null;

  setCommands(commands: PaletteCommand[]): void {
    this.commands = commands;
  }

  open(container: HTMLElement, onClose?: () => void): void {
    this.onClose = onClose ?? null;
    if (this.overlay) this.close();

    this.overlay = el('div', { class: 'engram-palette-overlay' });
    const modal = el('div', { class: 'engram-palette-modal' });

    const input = el('input', {
      class: 'engram-palette-input',
      type: 'text',
      placeholder: 'Type a command...',
    }) as HTMLInputElement;

    const list = el('div', { class: 'engram-palette-list' });

    const renderList = (filter: string) => {
      list.empty();
      const filtered = filter
        ? this.commands.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
        : this.commands;

      for (const cmd of filtered) {
        const item = el('div', { class: 'engram-palette-item' });
        if (cmd.icon) {
          item.appendChild(el('span', { class: 'engram-palette-icon', text: cmd.icon }));
        }
        item.appendChild(el('span', { text: cmd.name }));
        item.addEventListener('click', () => {
          this.close();
          cmd.callback();
        });
        list.appendChild(item);
      }

      if (filtered.length === 0) {
        list.appendChild(el('div', { class: 'engram-palette-empty', text: 'No matching commands' }));
      }
    };

    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      } else if (e.key === 'Enter') {
        const firstItem = list.querySelector('.engram-palette-item') as HTMLElement | null;
        firstItem?.click();
      }
    });

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    modal.appendChild(input);
    modal.appendChild(list);
    this.overlay.appendChild(modal);
    container.appendChild(this.overlay);

    renderList('');
    input.focus();
  }

  close(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.onClose?.();
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }
}
