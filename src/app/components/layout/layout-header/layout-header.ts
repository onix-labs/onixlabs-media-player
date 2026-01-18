import { Component, inject, computed } from '@angular/core';
import { ElectronService } from '../../../services/electron.service';

@Component({
  selector: 'app-layout-header',
  imports: [],
  templateUrl: './layout-header.html',
  styleUrl: './layout-header.scss',
})
export class LayoutHeader {
  private readonly electron: ElectronService = inject(ElectronService);

  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());

  public async toggleFullscreen(): Promise<void> {
    await this.electron.toggleFullscreen();
  }
}
