import { Component, inject, computed, HostBinding, OnDestroy, HostListener, signal } from '@angular/core';
import {LayoutHeader} from '../layout/layout-header/layout-header';
import {LayoutOutlet} from '../layout/layout-outlet/layout-outlet';
import {LayoutControls} from '../layout/layout-controls/layout-controls';
import {ElectronService} from '../../services/electron.service';
import {MediaPlayerService} from '../../services/media-player.service';

@Component({
  selector: 'app-root',
  imports: [LayoutHeader, LayoutOutlet, LayoutControls],
  templateUrl: './root.html',
  styleUrl: './root.scss',
})
export class Root implements OnDestroy {
  private readonly electron: ElectronService = inject(ElectronService);
  private readonly mediaPlayer: MediaPlayerService = inject(MediaPlayerService);

  public readonly isFullscreen: ReturnType<typeof computed<boolean>> = computed((): boolean => this.electron.isFullscreen());
  public readonly isVideo: ReturnType<typeof computed<boolean>> = computed((): boolean => this.mediaPlayer.currentMediaType() === 'video');
  private readonly controlsVisible: ReturnType<typeof signal<boolean>> = signal<boolean>(true);
  // In fullscreen: show floating controls on mouse movement for both audio and video
  public readonly showControls: ReturnType<typeof computed<boolean>> = computed((): boolean => !this.isFullscreen() || this.controlsVisible());

  private mouseTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly HIDE_DELAY_MS: number = 5000;

  @HostBinding('class.fullscreen')
  public get fullscreenClass(): boolean {
    return this.isFullscreen();
  }

  @HostListener('document:mousemove')
  public onMouseMove(): void {
    if (this.isFullscreen()) {
      this.showControlsTemporarily();
    }
  }

  @HostListener('document:keydown.escape')
  public onEscapeKey(): void {
    if (this.isFullscreen()) {
      void this.electron.exitFullscreen();
    }
  }

  public ngOnDestroy(): void {
    if (this.mouseTimeout) {
      clearTimeout(this.mouseTimeout);
    }
  }

  private showControlsTemporarily(): void {
    this.controlsVisible.set(true);

    if (this.mouseTimeout) {
      clearTimeout(this.mouseTimeout);
    }

    this.mouseTimeout = setTimeout((): void => {
      this.controlsVisible.set(false);
    }, this.HIDE_DELAY_MS);
  }
}
