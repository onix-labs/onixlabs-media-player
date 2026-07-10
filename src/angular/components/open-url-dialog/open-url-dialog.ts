/**
 * @fileoverview Dialog for playing video and audio from internet URLs.
 *
 * This is the renderer-side counterpart to the yt-dlp backend (the
 * TypeScript port of ReClip). The user pastes a URL, the dialog resolves
 * its metadata and quality options, and then either:
 * - downloads the media to a local file (default — robust, fully seekable), or
 * - resolves a direct stream URL and plays it immediately (opt-in).
 *
 * Both paths feed the resolved file/URL into the existing playlist pipeline
 * via {@link ElectronService}, so playback, visualizations, and transport
 * controls work unchanged.
 *
 * @module app/components/open-url-dialog
 */

import {Component, ChangeDetectionStrategy, HostBinding, inject, signal, computed, effect, ElementRef, type AfterViewInit, type OnDestroy, type WritableSignal, type Signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ElectronService, type UrlMediaInfo, type UrlMediaFormat, type DownloadJob} from '../../services/electron.service';
import {DependencyService} from '../../services/dependency.service';

/** Playback strategy for a URL: download to disk, or stream a direct URL. */
type UrlPlaybackMode = 'download' | 'stream';

/**
 * Standalone window view for opening internet media via yt-dlp.
 *
 * Rendered by the Root component in its own BrowserWindow (?window=open-url),
 * opened from the "Open URL..." menu item. Closes its window when the user
 * starts a download/stream or cancels.
 */
@Component({
  selector: 'app-open-url-dialog',
  imports: [FormsModule],
  templateUrl: './open-url-dialog.html',
  styleUrl: './open-url-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpenUrlDialog implements AfterViewInit, OnDestroy {
  // ==========================================================================
  // Dependencies
  // ==========================================================================

  private readonly electron: ElectronService = inject(ElectronService);
  private readonly deps: DependencyService = inject(DependencyService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Observes content size so the window can be resized to fit it. */
  private resizeObserver: ResizeObserver | null = null;

  // ==========================================================================
  // Form State
  // ==========================================================================

  /** The URL entered by the user. */
  public readonly url: WritableSignal<string> = signal<string>('');

  /** Requested output: video (MP4) or audio (MP3). */
  public readonly mediaFormat: WritableSignal<UrlMediaFormat> = signal<UrlMediaFormat>('video');

  /** Playback strategy: download to disk or stream directly. */
  public readonly mode: WritableSignal<UrlPlaybackMode> = signal<UrlPlaybackMode>('stream');

  /** Selected yt-dlp format id for the chosen video quality (null = best). */
  public readonly selectedFormatId: WritableSignal<string | null> = signal<string | null>(null);

  // ==========================================================================
  // Async State
  // ==========================================================================

  /** Resolved metadata for the current URL, null until fetched. */
  public readonly info: WritableSignal<UrlMediaInfo | null> = signal<UrlMediaInfo | null>(null);

  /** Whether metadata is being fetched. */
  public readonly loadingInfo: WritableSignal<boolean> = signal<boolean>(false);

  /** Whether a download/stream is currently being started or run. */
  public readonly submitting: WritableSignal<boolean> = signal<boolean>(false);

  /** Active download job id, used for cancellation. */
  public readonly activeJobId: WritableSignal<string | null> = signal<string | null>(null);

  /** Current error message, if any. */
  public readonly error: WritableSignal<string | null> = signal<string | null>(null);

  // ==========================================================================
  // Derived State
  // ==========================================================================

  /** Whether yt-dlp is installed; gating message shown when false. */
  public readonly ytdlpInstalled: Signal<boolean> = this.deps.ytdlpInstalled;

  /** Download progress (0..1) of the active job, or null when unknown. */
  public readonly progress: Signal<number | null> = computed((): number | null => {
    const job: DownloadJob | null = this.electron.downloadJob();
    if (!job || job.id !== this.activeJobId()) {
      return null;
    }
    return job.progress;
  });

  /** Download progress as a whole-number percentage for display. */
  public readonly progressPercent: Signal<number> = computed((): number => {
    const p: number | null = this.progress();
    return p === null ? 0 : Math.round(p * 100);
  });

  /** Whether the primary action button should be enabled. */
  public readonly canSubmit: Signal<boolean> = computed((): boolean =>
    !this.submitting() && this.info() !== null && this.ytdlpInstalled()
  );

  /**
   * Shows the waiting cursor while a stream is being started (the window
   * stays open through the yt-dlp URL resolve, then closes once playback is
   * handed to the main window). Downloads show a progress bar instead.
   */
  @HostBinding('class.cursor-busy')
  public get cursorBusyClass(): boolean {
    return this.submitting() && this.mode() === 'stream';
  }

  public constructor() {
    // React to download job completion/failure for the active job.
    effect((): void => {
      const job: DownloadJob | null = this.electron.downloadJob();
      const activeId: string | null = this.activeJobId();
      if (!job || job.id !== activeId) {
        return;
      }
      if (job.status === 'done') {
        // File has been added and playback started by the service — close.
        this.close();
      } else if (job.status === 'error') {
        this.error.set(job.errorMessage ?? 'Download failed');
        this.submitting.set(false);
        this.activeJobId.set(null);
      }
    });
  }

  /** Starts observing content size so the window can grow/shrink to fit. */
  public ngAfterViewInit(): void {
    const element: HTMLElement = this.host.nativeElement;
    this.resizeObserver = new ResizeObserver((): void => {
      void this.electron.setContentHeight(Math.ceil(element.getBoundingClientRect().height));
    });
    this.resizeObserver.observe(element);
  }

  public ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  // ==========================================================================
  // Actions
  // ==========================================================================

  /**
   * Fetches info automatically when a URL is pasted into the input.
   * Deferred a tick so the pasted text is committed to the model first
   * (handles both replace and append cases), then fetches.
   */
  public onPaste(): void {
    setTimeout((): void => {
      void this.fetchInfo();
    }, 0);
  }

  /** Resolves metadata and quality options for the entered URL. */
  public async fetchInfo(): Promise<void> {
    const value: string = this.url().trim();
    if (!value || this.loadingInfo()) {
      return;
    }
    this.loadingInfo.set(true);
    this.error.set(null);
    this.info.set(null);
    this.selectedFormatId.set(null);

    try {
      const info: UrlMediaInfo = await this.electron.getUrlInfo(value);
      this.info.set(info);
      // Default to the highest available quality.
      this.selectedFormatId.set(info.formats.length > 0 ? info.formats[0].id : null);
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : 'Could not load that URL');
    } finally {
      this.loadingInfo.set(false);
    }
  }

  /** Starts the download or stream, depending on the selected mode. */
  public async submit(): Promise<void> {
    if (!this.canSubmit()) {
      return;
    }
    const value: string = this.url().trim();
    const format: UrlMediaFormat = this.mediaFormat();
    this.submitting.set(true);
    this.error.set(null);

    try {
      if (this.mode() === 'stream') {
        await this.electron.streamUrl(value, format, this.selectedHeight());
        this.close();
        return;
      }
      const formatId: string | null = format === 'video' ? this.selectedFormatId() : null;
      const result: {jobId: string} = await this.electron.downloadUrl(value, format, formatId, this.info()?.title ?? '');
      this.activeJobId.set(result.jobId);
      // Completion/error handled by the effect watching downloadJob.
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : 'Failed to start');
      this.submitting.set(false);
    }
  }

  /** Cancels an in-flight download and resets to the form. */
  public async cancel(): Promise<void> {
    const jobId: string | null = this.activeJobId();
    if (jobId) {
      await this.electron.cancelDownload(jobId);
    }
    this.activeJobId.set(null);
    this.submitting.set(false);
  }

  /** Closes the window. */
  public close(): void {
    window.close();
  }

  /** Opens the dependency settings so the user can install yt-dlp. */
  public openDependencySettings(): void {
    void this.electron.showConfigurationWindow('dependencies');
  }

  /** Sets the requested output format (MP4/MP3) from the select value. */
  public setFormat(value: string): void {
    this.mediaFormat.set(value === 'audio' ? 'audio' : 'video');
  }

  /** Sets the playback mode (download/stream) from the select value. */
  public setMode(value: string): void {
    this.mode.set(value === 'stream' ? 'stream' : 'download');
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** Resolves the selected video height (for stream max-height), or null. */
  private selectedHeight(): number | null {
    const id: string | null = this.selectedFormatId();
    const match: UrlMediaInfo | null = this.info();
    if (!id || !match) {
      return null;
    }
    const format: {height: number} | undefined = match.formats.find((f: {id: string; height: number}): boolean => f.id === id);
    return format ? format.height : null;
  }
}
