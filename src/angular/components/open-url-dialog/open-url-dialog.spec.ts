/**
 * @fileoverview Tests for OpenUrlDialog.
 *
 * Tests cover:
 * - fetchInfo success, failure and the re-entry guard
 * - Quality defaulting to the highest available format
 * - submit() in both stream and download modes, including the Save As dialog
 *   that precedes a download, and failure handling
 * - The effect that reacts to the active download job completing or failing
 * - Cancellation and the small form setters
 *
 * @module app/components/open-url-dialog.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ElementRef, signal, type WritableSignal} from '@angular/core';
import {OpenUrlDialog} from './open-url-dialog';
import {ElectronService, type UrlMediaInfo, type DownloadJob} from '../../services/electron.service';
import {DependencyService, type InstallProgress} from '../../services/dependency.service';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Builds a metadata payload with the given quality options.
 *
 * @param heights - Video heights to expose, in the order yt-dlp would
 * @returns Media info for the dialog
 */
function createInfo(heights: number[] = [1080, 720]): UrlMediaInfo {
  return {
    title: 'A Video',
    thumbnail: 'http://img',
    duration: 120,
    uploader: 'Someone',
    formats: heights.map((h: number): {id: string; label: string; height: number} => ({
      id: `fmt-${h}`,
      label: `${h}p`,
      height: h,
    })),
  } as UrlMediaInfo;
}

/**
 * Builds a download job.
 *
 * @param overrides - Fields to override on the default job
 * @returns A download job
 */
function createJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-1',
    url: 'https://example.com/v',
    format: 'video',
    status: 'downloading',
    progress: null,
    title: 'A Video',
    filePath: null,
    errorMessage: null,
    ...overrides,
  } as DownloadJob;
}

/** Creates an ElectronService stub with a controllable downloadJob signal. */
function createMockElectron(): Record<string, unknown> {
  return {
    downloadJob: signal<DownloadJob | null>(null),
    getUrlInfo: vi.fn().mockResolvedValue(createInfo()),
    streamUrl: vi.fn().mockResolvedValue(undefined),
    saveMediaDialog: vi.fn().mockResolvedValue('/chosen/A Video.mp4'),
    downloadUrl: vi.fn().mockResolvedValue({jobId: 'job-1'}),
    cancelDownload: vi.fn().mockResolvedValue(undefined),
    setContentHeight: vi.fn().mockResolvedValue(undefined),
    showConfigurationWindow: vi.fn().mockResolvedValue(undefined),
  };
}

/** Creates a DependencyService stub. */
function createMockDeps(): Record<string, unknown> {
  return {
    ytdlpInstalled: signal(true),
    isOperationInProgress: signal(false),
    installProgress: signal(null),
    installDependency: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('OpenUrlDialog', (): void => {
  let component: OpenUrlDialog;
  let mockElectron: ReturnType<typeof createMockElectron>;
  let mockDeps: ReturnType<typeof createMockDeps>;

  beforeEach((): void => {
    mockElectron = createMockElectron();
    mockDeps = createMockDeps();

    TestBed.configureTestingModule({
      providers: [
        OpenUrlDialog,
        {provide: ElectronService, useValue: mockElectron},
        {provide: DependencyService, useValue: mockDeps},
        // The dialog is exercised as a class rather than through a fixture:
        // its ngAfterViewInit constructs a ResizeObserver, which the test DOM
        // does not implement. ElementRef therefore has to be supplied here,
        // and a bare stub suffices because nativeElement is only read from
        // that hook.
        {provide: ElementRef, useValue: new ElementRef<HTMLElement>({} as HTMLElement)},
      ],
    });

    component = TestBed.inject(OpenUrlDialog);
  });

  // ==========================================================================
  // fetchInfo
  // ==========================================================================

  describe('fetchInfo', (): void => {
    it('does nothing for an empty URL', async (): Promise<void> => {
      await component.fetchInfo();

      expect(mockElectron['getUrlInfo']).not.toHaveBeenCalled();
    });

    it('does nothing for a whitespace-only URL', async (): Promise<void> => {
      component.url.set('   ');

      await component.fetchInfo();

      expect(mockElectron['getUrlInfo']).not.toHaveBeenCalled();
    });

    it('trims the URL before resolving it', async (): Promise<void> => {
      component.url.set('  https://example.com/v  ');

      await component.fetchInfo();

      expect(mockElectron['getUrlInfo']).toHaveBeenCalledWith('https://example.com/v');
    });

    it('stores the resolved info', async (): Promise<void> => {
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.info()?.title).toBe('A Video');
    });

    it('defaults to the highest available quality', async (): Promise<void> => {
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.selectedFormatId()).toBe('fmt-1080');
    });

    it('leaves the quality null when there are no video formats', async (): Promise<void> => {
      (mockElectron['getUrlInfo'] as ReturnType<typeof vi.fn>).mockResolvedValue(createInfo([]));
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.selectedFormatId()).toBeNull();
    });

    it('clears loadingInfo when it succeeds', async (): Promise<void> => {
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.loadingInfo()).toBe(false);
    });

    it('surfaces the error message and clears loadingInfo on failure', async (): Promise<void> => {
      (mockElectron['getUrlInfo'] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Video unavailable'));
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.error()).toBe('Video unavailable');
      expect(component.loadingInfo()).toBe(false);
      expect(component.info()).toBeNull();
    });

    it('falls back to a generic message for a non-Error rejection', async (): Promise<void> => {
      (mockElectron['getUrlInfo'] as ReturnType<typeof vi.fn>).mockRejectedValue('boom');
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.error()).toBe('Could not load that URL');
    });

    it('clears a previous error when retried', async (): Promise<void> => {
      component.error.set('old failure');
      component.url.set('https://example.com/v');

      await component.fetchInfo();

      expect(component.error()).toBeNull();
    });

    it('ignores a second call while one is in flight', async (): Promise<void> => {
      component.url.set('https://example.com/v');
      component.loadingInfo.set(true);

      await component.fetchInfo();

      expect(mockElectron['getUrlInfo']).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // canSubmit
  // ==========================================================================

  describe('canSubmit', (): void => {
    it('is false before any info is resolved', (): void => {
      expect(component.canSubmit()).toBe(false);
    });

    it('is true once info is resolved', async (): Promise<void> => {
      component.url.set('https://example.com/v');
      await component.fetchInfo();

      expect(component.canSubmit()).toBe(true);
    });

    it('is false while submitting', async (): Promise<void> => {
      component.url.set('https://example.com/v');
      await component.fetchInfo();
      component.submitting.set(true);

      expect(component.canSubmit()).toBe(false);
    });

    it('is false when yt-dlp is not installed', async (): Promise<void> => {
      component.url.set('https://example.com/v');
      await component.fetchInfo();
      (mockDeps['ytdlpInstalled'] as WritableSignal<boolean>).set(false);

      expect(component.canSubmit()).toBe(false);
    });
  });

  // ==========================================================================
  // submit — stream mode
  // ==========================================================================

  describe('submit in stream mode', (): void => {
    beforeEach(async (): Promise<void> => {
      component.url.set('https://example.com/v');
      await component.fetchInfo();
      component.mode.set('stream');
    });

    it('does nothing when submission is not allowed', async (): Promise<void> => {
      component.submitting.set(true);

      await component.submit();

      expect(mockElectron['streamUrl']).not.toHaveBeenCalled();
    });

    it('streams with the selected height', async (): Promise<void> => {
      component.selectedFormatId.set('fmt-720');

      await component.submit();

      expect(mockElectron['streamUrl']).toHaveBeenCalledWith('https://example.com/v', 'video', 720);
    });

    it('passes a null height when no quality is selected', async (): Promise<void> => {
      component.selectedFormatId.set(null);

      await component.submit();

      expect(mockElectron['streamUrl']).toHaveBeenCalledWith('https://example.com/v', 'video', null);
    });

    it('passes a null height when the selected id is unknown', async (): Promise<void> => {
      component.selectedFormatId.set('fmt-gone');

      await component.submit();

      expect(mockElectron['streamUrl']).toHaveBeenCalledWith('https://example.com/v', 'video', null);
    });

    it('closes the window on success', async (): Promise<void> => {
      const close = vi.spyOn(component, 'close').mockImplementation((): void => {});

      await component.submit();

      expect(close).toHaveBeenCalled();
    });

    it('surfaces the error and stops submitting on failure', async (): Promise<void> => {
      (mockElectron['streamUrl'] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No stream'));

      await component.submit();

      expect(component.error()).toBe('No stream');
      expect(component.submitting()).toBe(false);
    });

    it('falls back to a generic message for a non-Error rejection', async (): Promise<void> => {
      (mockElectron['streamUrl'] as ReturnType<typeof vi.fn>).mockRejectedValue('boom');

      await component.submit();

      expect(component.error()).toBe('Failed to start');
    });
  });

  // ==========================================================================
  // submit — download mode
  // ==========================================================================

  describe('submit in download mode', (): void => {
    beforeEach(async (): Promise<void> => {
      component.url.set('https://example.com/v');
      await component.fetchInfo();
      component.mode.set('download');
    });

    it('stores the returned job id', async (): Promise<void> => {
      await component.submit();

      expect(component.activeJobId()).toBe('job-1');
    });

    it('asks where to save before downloading', async (): Promise<void> => {
      await component.submit();

      expect(mockElectron['saveMediaDialog']).toHaveBeenCalledWith('A Video', 'video');
    });

    it('offers an mp3 destination for audio', async (): Promise<void> => {
      component.mediaFormat.set('audio');

      await component.submit();

      expect(mockElectron['saveMediaDialog']).toHaveBeenCalledWith('A Video', 'audio');
    });

    it('downloads to the chosen path', async (): Promise<void> => {
      await component.submit();

      expect(mockElectron['downloadUrl']).toHaveBeenCalledWith(
        'https://example.com/v', 'video', 'fmt-1080', 'A Video', '/chosen/A Video.mp4'
      );
    });

    it('passes the selected format id for video', async (): Promise<void> => {
      component.selectedFormatId.set('fmt-720');

      await component.submit();

      expect(mockElectron['downloadUrl']).toHaveBeenCalledWith(
        'https://example.com/v', 'video', 'fmt-720', 'A Video', '/chosen/A Video.mp4'
      );
    });

    it('never passes a format id for audio', async (): Promise<void> => {
      component.mediaFormat.set('audio');
      component.selectedFormatId.set('fmt-720');

      await component.submit();

      expect(mockElectron['downloadUrl']).toHaveBeenCalledWith(
        'https://example.com/v', 'audio', null, 'A Video', '/chosen/A Video.mp4'
      );
    });

    it('starts nothing when the save dialog is cancelled', async (): Promise<void> => {
      (mockElectron['saveMediaDialog'] as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await component.submit();

      expect(mockElectron['downloadUrl']).not.toHaveBeenCalled();
      expect(component.submitting()).toBe(false);
      expect(component.error()).toBeNull();
    });

    it('can be retried after the save dialog was cancelled', async (): Promise<void> => {
      const saveDialog = mockElectron['saveMediaDialog'] as ReturnType<typeof vi.fn>;
      saveDialog.mockResolvedValueOnce(null);

      await component.submit();
      await component.submit();

      expect(mockElectron['downloadUrl']).toHaveBeenCalledTimes(1);
      expect(component.activeJobId()).toBe('job-1');
    });

    it('stays submitting while the job runs', async (): Promise<void> => {
      await component.submit();

      expect(component.submitting()).toBe(true);
    });

    it('surfaces the error and stops submitting when starting fails', async (): Promise<void> => {
      (mockElectron['downloadUrl'] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('yt-dlp missing'));

      await component.submit();

      expect(component.error()).toBe('yt-dlp missing');
      expect(component.submitting()).toBe(false);
      expect(component.activeJobId()).toBeNull();
    });
  });

  // ==========================================================================
  // Download Job Effect
  // ==========================================================================

  describe('download job reactions', (): void => {
    /** Publishes a job on the mocked service and flushes the effect. */
    function publish(job: DownloadJob | null): void {
      (mockElectron['downloadJob'] as WritableSignal<DownloadJob | null>).set(job);
      TestBed.tick();
    }

    it('closes the window when the active job finishes', (): void => {
      const close = vi.spyOn(component, 'close').mockImplementation((): void => {});
      component.activeJobId.set('job-1');

      publish(createJob({status: 'done'}));

      expect(close).toHaveBeenCalled();
    });

    it('shows the error and clears the job when it fails', (): void => {
      component.activeJobId.set('job-1');
      component.submitting.set(true);

      publish(createJob({status: 'error', errorMessage: 'HTTP 403'}));

      expect(component.error()).toBe('HTTP 403');
      expect(component.submitting()).toBe(false);
      expect(component.activeJobId()).toBeNull();
    });

    it('uses a generic message when the failure has no detail', (): void => {
      component.activeJobId.set('job-1');

      publish(createJob({status: 'error', errorMessage: null}));

      expect(component.error()).toBe('Download failed');
    });

    it('ignores a job belonging to another dialog', (): void => {
      const close = vi.spyOn(component, 'close').mockImplementation((): void => {});
      component.activeJobId.set('job-1');

      publish(createJob({id: 'other-job', status: 'done'}));

      expect(close).not.toHaveBeenCalled();
      expect(component.error()).toBeNull();
    });

    it('ignores job updates when nothing is active', (): void => {
      const close = vi.spyOn(component, 'close').mockImplementation((): void => {});

      publish(createJob({status: 'done'}));

      expect(close).not.toHaveBeenCalled();
    });

    it('does nothing for a job still downloading', (): void => {
      const close = vi.spyOn(component, 'close').mockImplementation((): void => {});
      component.activeJobId.set('job-1');

      publish(createJob({status: 'downloading', progress: 0.5}));

      expect(close).not.toHaveBeenCalled();
      expect(component.error()).toBeNull();
    });
  });

  // ==========================================================================
  // Progress
  // ==========================================================================

  describe('progress', (): void => {
    it('is null with no active job', (): void => {
      expect(component.progress()).toBeNull();
      expect(component.progressPercent()).toBe(0);
    });

    it('reports the active job progress', (): void => {
      component.activeJobId.set('job-1');
      (mockElectron['downloadJob'] as WritableSignal<DownloadJob | null>).set(createJob({progress: 0.425}));

      expect(component.progress()).toBeCloseTo(0.425);
      expect(component.progressPercent()).toBe(43);
    });

    it('ignores progress from another job', (): void => {
      component.activeJobId.set('job-1');
      (mockElectron['downloadJob'] as WritableSignal<DownloadJob | null>).set(
        createJob({id: 'other', progress: 0.9})
      );

      expect(component.progress()).toBeNull();
    });
  });

  // ==========================================================================
  // Cancellation and Setters
  // ==========================================================================

  describe('cancel', (): void => {
    it('cancels the active job and resets the form', async (): Promise<void> => {
      component.activeJobId.set('job-1');
      component.submitting.set(true);

      await component.cancel();

      expect(mockElectron['cancelDownload']).toHaveBeenCalledWith('job-1');
      expect(component.activeJobId()).toBeNull();
      expect(component.submitting()).toBe(false);
    });

    it('still resets the form when there is no active job', async (): Promise<void> => {
      component.submitting.set(true);

      await component.cancel();

      expect(mockElectron['cancelDownload']).not.toHaveBeenCalled();
      expect(component.submitting()).toBe(false);
    });
  });

  describe('form setters', (): void => {
    it('accepts audio and treats anything else as video', (): void => {
      component.setFormat('audio');
      expect(component.mediaFormat()).toBe('audio');

      component.setFormat('anything');
      expect(component.mediaFormat()).toBe('video');
    });

    it('accepts stream and treats anything else as download', (): void => {
      component.setMode('stream');
      expect(component.mode()).toBe('stream');

      component.setMode('anything');
      expect(component.mode()).toBe('download');
    });

    it('downloads yt-dlp in place', (): void => {
      component.downloadYtDlp();

      expect(mockDeps['installDependency']).toHaveBeenCalledWith('yt-dlp');
    });

    it('shows yt-dlp download progress but not its success', (): void => {
      const progress: WritableSignal<unknown> = mockDeps['installProgress'] as WritableSignal<unknown>;

      progress.set({dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading yt-dlp 2026.10.26... 40%'});
      expect(component.ytdlpDownloadMessage()).toBe('Downloading yt-dlp 2026.10.26... 40%');

      progress.set({dependencyId: 'yt-dlp', status: 'success', message: 'yt-dlp installed: 2026.10.26.'});
      expect(component.ytdlpDownloadMessage()).toBeNull();
    });
  });
});

// ============================================================================
// Rendered behaviour
// ============================================================================

/**
 * Stand-in for ResizeObserver, which the test DOM does not implement. Records
 * what is observed and lets a test report a size change.
 */
class FakeResizeObserver {
  public static readonly instances: FakeResizeObserver[] = [];
  public readonly observed: Element[] = [];
  public disconnected: boolean = false;
  private readonly callback: () => void;

  public constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  public observe(element: Element): void {
    this.observed.push(element);
  }

  public unobserve(): void {
    this.observed.length = 0;
  }

  public disconnect(): void {
    this.disconnected = true;
  }

  /** Reports a size change, as the browser would after layout. */
  public notify(): void {
    this.callback();
  }
}

describe('OpenUrlDialog rendered', (): void => {
  const MEDIA_URL: string = 'https://example.com/v';
  let fixture: ComponentFixture<OpenUrlDialog>;
  let host: HTMLElement;
  let mockElectron: ReturnType<typeof createMockElectron>;
  let mockDeps: ReturnType<typeof createMockDeps>;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  /** Returns a spy from the fake ElectronService by name. */
  function electronSpy(name: string): ReturnType<typeof vi.fn> {
    return mockElectron[name] as ReturnType<typeof vi.fn>;
  }

  /** Creates the dialog and waits for its first render. */
  async function createDialog(): Promise<void> {
    fixture = TestBed.createComponent(OpenUrlDialog);
    host = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  }

  /** Finds a button by its visible label. */
  function button(label: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll('button')).find((candidate: HTMLButtonElement): boolean => candidate.textContent.trim() === label);
  }

  /** Returns the MEDIA_URL text box. */
  function urlInput(): HTMLInputElement {
    return host.querySelector<HTMLInputElement>('.url-input')!;
  }

  /** Finds the dropdown in the row with the given label. */
  function dropdown(label: string): HTMLSelectElement | undefined {
    const row: Element | undefined = Array.from(host.querySelectorAll('.url-row'))
      .find((candidate: Element): boolean => candidate.querySelector('.url-row-label')?.textContent === label);
    return row?.querySelector<HTMLSelectElement>('select') ?? undefined;
  }

  /** Types a MEDIA_URL into the text box, as a user would. */
  async function typeUrl(value: string): Promise<void> {
    urlInput().value = value;
    urlInput().dispatchEvent(new Event('input', {bubbles: true}));
    await fixture.whenStable();
  }

  /** Picks a value in a labelled dropdown, as a user would. */
  async function choose(label: string, value: string): Promise<void> {
    const element: HTMLSelectElement = dropdown(label)!;
    element.value = value;
    element.dispatchEvent(new Event('change', {bubbles: true}));
    await fixture.whenStable();
  }

  /** Types a MEDIA_URL and fetches its details. */
  async function fetchDetails(): Promise<void> {
    await typeUrl(MEDIA_URL);
    button('Fetch')!.click();
    await fixture.whenStable();
  }

  /** Publishes a download job update, as the server would. */
  async function publishJob(job: DownloadJob): Promise<void> {
    (mockElectron['downloadJob'] as WritableSignal<DownloadJob | null>).set(job);
    await fixture.whenStable();
  }

  beforeEach((): void => {
    mockElectron = createMockElectron();
    mockDeps = createMockDeps();
    FakeResizeObserver.instances.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    closeSpy = vi.spyOn(window, 'close').mockImplementation((): void => {});

    TestBed.configureTestingModule({
      imports: [OpenUrlDialog],
      providers: [
        {provide: ElectronService, useValue: mockElectron},
        {provide: DependencyService, useValue: mockDeps},
      ],
    });
  });

  afterEach((): void => {
    fixture.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Without yt-dlp
  // ==========================================================================

  describe('without yt-dlp', (): void => {
    beforeEach(async (): Promise<void> => {
      (mockDeps['ytdlpInstalled'] as WritableSignal<boolean>).set(false);
      await createDialog();
    });

    it('explains that yt-dlp is needed instead of offering the MEDIA_URL form', (): void => {
      expect(host.querySelector('.url-dialog-notice')?.textContent).toContain('yt-dlp');
      expect(host.querySelector('.url-input')).toBeNull();
      expect(host.querySelector('.url-dialog-footer')).toBeNull();
    });

    it('downloads yt-dlp when the button is clicked', (): void => {
      button('Download yt-dlp')!.click();

      expect(mockDeps['installDependency']).toHaveBeenCalledExactlyOnceWith('yt-dlp');
    });

    it('disables the download button while a download is running', async (): Promise<void> => {
      (mockDeps['isOperationInProgress'] as WritableSignal<boolean>).set(true);
      await fixture.whenStable();

      expect(button('Download yt-dlp')!.disabled).toBe(true);
    });

    it('shows the download progress message', async (): Promise<void> => {
      (mockDeps['installProgress'] as WritableSignal<InstallProgress | null>).set({dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading yt-dlp… 40%'});
      await fixture.whenStable();

      const notices: string[] = Array.from(host.querySelectorAll('.url-dialog-notice')).map((notice: Element): string => notice.textContent.trim());
      expect(notices[1]).toBe('Downloading yt-dlp… 40%');
    });

    it('shows why the download failed', async (): Promise<void> => {
      (mockDeps['installProgress'] as WritableSignal<InstallProgress | null>).set({dependencyId: 'yt-dlp', status: 'error', message: 'Could not install yt-dlp: network down'});
      await fixture.whenStable();

      expect(host.textContent).toContain('Could not install yt-dlp: network down');
    });

    it('shows no progress message for another dependency', async (): Promise<void> => {
      (mockDeps['installProgress'] as WritableSignal<InstallProgress | null>).set({dependencyId: 'ffmpeg', status: 'installing', message: 'Installing FFmpeg'});
      await fixture.whenStable();

      expect(host.querySelectorAll('.url-dialog-notice')).toHaveLength(1);
    });

    it('swaps to the MEDIA_URL form once yt-dlp is installed', async (): Promise<void> => {
      (mockDeps['ytdlpInstalled'] as WritableSignal<boolean>).set(true);
      await fixture.whenStable();

      expect(host.querySelector('.url-input')).not.toBeNull();
      expect(button('Download yt-dlp')).toBeUndefined();
    });
  });

  // ==========================================================================
  // Fetching details
  // ==========================================================================

  describe('fetching details', (): void => {
    beforeEach(async (): Promise<void> => {
      await createDialog();
    });

    it('keeps Fetch and Play disabled until a MEDIA_URL is typed', (): void => {
      expect(button('Fetch')!.disabled).toBe(true);
      expect(button('Play')!.disabled).toBe(true);
    });

    it('keeps Fetch disabled for a blank MEDIA_URL', async (): Promise<void> => {
      await typeUrl('   ');

      expect(button('Fetch')!.disabled).toBe(true);
    });

    it('resolves the typed MEDIA_URL when Fetch is clicked', async (): Promise<void> => {
      await typeUrl(`  ${MEDIA_URL}  `);

      button('Fetch')!.click();

      expect(electronSpy('getUrlInfo')).toHaveBeenCalledExactlyOnceWith(MEDIA_URL);
    });

    it('resolves the typed MEDIA_URL when Enter is pressed', async (): Promise<void> => {
      await typeUrl(MEDIA_URL);

      urlInput().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));

      expect(electronSpy('getUrlInfo')).toHaveBeenCalledExactlyOnceWith(MEDIA_URL);
    });

    it('resolves a pasted MEDIA_URL once the pasted text has been committed', async (): Promise<void> => {
      vi.useFakeTimers();
      urlInput().dispatchEvent(new Event('paste', {bubbles: true}));
      urlInput().value = MEDIA_URL;
      urlInput().dispatchEvent(new Event('input', {bubbles: true}));

      await vi.advanceTimersByTimeAsync(0);

      expect(electronSpy('getUrlInfo')).toHaveBeenCalledExactlyOnceWith(MEDIA_URL);
    });

    it('does not resolve a pasted MEDIA_URL before the paste has been committed', (): void => {
      vi.useFakeTimers();
      urlInput().value = MEDIA_URL;
      urlInput().dispatchEvent(new Event('input', {bubbles: true}));

      urlInput().dispatchEvent(new Event('paste', {bubbles: true}));

      expect(electronSpy('getUrlInfo')).not.toHaveBeenCalled();
    });

    it('shows that details are loading and blocks a second fetch', async (): Promise<void> => {
      electronSpy('getUrlInfo').mockReturnValue(new Promise<UrlMediaInfo>((): void => {}));
      await typeUrl(MEDIA_URL);

      button('Fetch')!.click();
      await fixture.whenStable();

      expect(button('Loading…')!.disabled).toBe(true);
    });

    it('shows the title, uploader and thumbnail of the resolved media', async (): Promise<void> => {
      await fetchDetails();

      expect(host.querySelector('.url-meta-title')?.textContent).toBe('A Video');
      expect(host.querySelector('.url-meta-sub')?.textContent).toBe('Someone');
      expect(host.querySelector<HTMLImageElement>('.url-thumb')?.getAttribute('src')).toBe('http://img');
    });

    it('falls back to Untitled and omits missing details', async (): Promise<void> => {
      electronSpy('getUrlInfo').mockResolvedValue({...createInfo(), title: '', uploader: '', thumbnail: ''});

      await fetchDetails();

      expect(host.querySelector('.url-meta-title')?.textContent).toBe('Untitled');
      expect(host.querySelector('.url-meta-sub')).toBeNull();
      expect(host.querySelector('.url-thumb')).toBeNull();
    });

    it('shows the reason and no preview when the MEDIA_URL cannot be resolved', async (): Promise<void> => {
      electronSpy('getUrlInfo').mockRejectedValue(new Error('Unsupported MEDIA_URL'));

      await fetchDetails();

      expect(host.querySelector('.url-error')?.textContent).toBe('Unsupported MEDIA_URL');
      expect(host.querySelector('.url-preview')).toBeNull();
      expect(button('Play')!.disabled).toBe(true);
    });

    it('clears the error when a retry succeeds', async (): Promise<void> => {
      electronSpy('getUrlInfo').mockRejectedValueOnce(new Error('Unsupported MEDIA_URL'));
      await fetchDetails();

      button('Fetch')!.click();
      await fixture.whenStable();

      expect(host.querySelector('.url-error')).toBeNull();
      expect(host.querySelector('.url-preview')).not.toBeNull();
    });
  });

  // ==========================================================================
  // Options
  // ==========================================================================

  describe('options', (): void => {
    beforeEach(async (): Promise<void> => {
      await createDialog();
      await fetchDetails();
    });

    it('lists the available qualities with the best one selected', (): void => {
      const quality: HTMLSelectElement = dropdown('Quality')!;

      expect(Array.from(quality.options).map((option: HTMLOptionElement): string => option.textContent.trim())).toEqual(['1080p', '720p']);
      expect(quality.value).toBe('fmt-1080');
    });

    it('hides the quality choice for audio', async (): Promise<void> => {
      await choose('Format', 'audio');

      expect(dropdown('Quality')).toBeUndefined();
    });

    it('hides the quality choice when the media offers no video formats', async (): Promise<void> => {
      electronSpy('getUrlInfo').mockResolvedValue(createInfo([]));

      button('Fetch')!.click();
      await fixture.whenStable();

      expect(dropdown('Quality')).toBeUndefined();
    });

    it('starts in stream mode with a Play button', (): void => {
      expect(dropdown('Mode')!.value).toBe('stream');
      expect(button('Play')!.disabled).toBe(false);
      expect(host.querySelector('.url-mode-hint')?.textContent).toContain('Plays directly from the source');
    });

    it('offers Download & Play in download mode', async (): Promise<void> => {
      await choose('Mode', 'download');

      expect(button('Download & Play')!.disabled).toBe(false);
      expect(button('Play')).toBeUndefined();
      expect(host.querySelector('.url-mode-hint')?.textContent).toContain('Asks where to save');
    });
  });

  // ==========================================================================
  // Streaming
  // ==========================================================================

  describe('streaming', (): void => {
    beforeEach(async (): Promise<void> => {
      await createDialog();
      await fetchDetails();
    });

    it('streams the MEDIA_URL at the selected quality when Play is clicked', async (): Promise<void> => {
      await choose('Quality', 'fmt-720');

      button('Play')!.click();

      expect(electronSpy('streamUrl')).toHaveBeenCalledExactlyOnceWith(MEDIA_URL, 'video', 720);
    });

    it('streams audio when the audio format is chosen', async (): Promise<void> => {
      await choose('Format', 'audio');

      button('Play')!.click();

      expect(electronSpy('streamUrl').mock.calls[0].slice(0, 2)).toEqual([MEDIA_URL, 'audio']);
    });

    it('closes the window once the stream has been handed over', async (): Promise<void> => {
      button('Play')!.click();
      await fixture.whenStable();

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('shows a busy cursor and locks the form while the stream is resolved', async (): Promise<void> => {
      electronSpy('streamUrl').mockReturnValue(new Promise<void>((): void => {}));

      button('Play')!.click();
      await fixture.whenStable();

      expect(host.classList.contains('cursor-busy')).toBe(true);
      expect(urlInput().disabled).toBe(true);
      expect(button('Play')!.disabled).toBe(true);
      expect(button('Cancel')!.disabled).toBe(true);
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('shows the reason and unlocks the form when the stream cannot start', async (): Promise<void> => {
      electronSpy('streamUrl').mockRejectedValue(new Error('Stream unavailable'));

      button('Play')!.click();
      await fixture.whenStable();

      expect(host.querySelector('.url-error')?.textContent).toBe('Stream unavailable');
      expect(host.classList.contains('cursor-busy')).toBe(false);
      expect(button('Play')!.disabled).toBe(false);
    });

    it('closes the window when Cancel is clicked', (): void => {
      button('Cancel')!.click();

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(electronSpy('cancelDownload')).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Downloading
  // ==========================================================================

  describe('downloading', (): void => {
    beforeEach(async (): Promise<void> => {
      await createDialog();
      await fetchDetails();
      await choose('Mode', 'download');
    });

    /** Starts the download and waits for the job to be registered. */
    async function startDownload(): Promise<void> {
      button('Download & Play')!.click();
      await fixture.whenStable();
    }

    it('asks where to save, then downloads the selected quality there', async (): Promise<void> => {
      await choose('Quality', 'fmt-720');

      await startDownload();

      expect(electronSpy('saveMediaDialog')).toHaveBeenCalledExactlyOnceWith('A Video', 'video');
      expect(electronSpy('downloadUrl')).toHaveBeenCalledExactlyOnceWith(MEDIA_URL, 'video', 'fmt-720', 'A Video', '/chosen/A Video.mp4');
    });

    it('suggests an empty file name when the media has no title', async (): Promise<void> => {
      electronSpy('getUrlInfo').mockResolvedValue({...createInfo(), title: undefined});
      button('Fetch')!.click();
      await fixture.whenStable();

      await startDownload();

      expect(electronSpy('saveMediaDialog')).toHaveBeenCalledExactlyOnceWith('', 'video');
    });

    it('shows that the download is starting and offers to cancel it', async (): Promise<void> => {
      await startDownload();

      expect(host.querySelector('.url-progress-label')?.textContent).toBe('Starting…');
      expect(button('Cancel Download')).toBeDefined();
      expect(button('Download & Play')).toBeUndefined();
      expect(host.classList.contains('cursor-busy')).toBe(false);
    });

    it('shows the progress of the running download', async (): Promise<void> => {
      await startDownload();

      await publishJob(createJob({progress: 0.424}));

      expect(host.querySelector('.url-progress-label')?.textContent).toBe('42%');
      expect(host.querySelector<HTMLElement>('.url-progress-fill')!.style.width).toBe('42%');
    });

    it('ignores the progress of a download started elsewhere', async (): Promise<void> => {
      await startDownload();

      await publishJob(createJob({id: 'job-2', progress: 0.9}));

      expect(host.querySelector('.url-progress-label')?.textContent).toBe('Starting…');
    });

    it('leaves the form as it was when the save dialog is cancelled', async (): Promise<void> => {
      electronSpy('saveMediaDialog').mockResolvedValue(null);

      await startDownload();

      expect(electronSpy('downloadUrl')).not.toHaveBeenCalled();
      expect(host.querySelector('.url-progress')).toBeNull();
      expect(button('Download & Play')!.disabled).toBe(false);
    });

    it('cancels the running download and returns to the form', async (): Promise<void> => {
      await startDownload();

      button('Cancel Download')!.click();
      await fixture.whenStable();

      expect(electronSpy('cancelDownload')).toHaveBeenCalledExactlyOnceWith('job-1');
      expect(host.querySelector('.url-progress')).toBeNull();
      expect(button('Download & Play')!.disabled).toBe(false);
    });

    it('closes the window when the download finishes', async (): Promise<void> => {
      await startDownload();

      await publishJob(createJob({status: 'done', progress: 1}));

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('shows the reason and returns to the form when the download fails', async (): Promise<void> => {
      await startDownload();

      await publishJob(createJob({status: 'error', errorMessage: 'Disk full'}));

      expect(host.querySelector('.url-error')?.textContent).toBe('Disk full');
      expect(host.querySelector('.url-progress')).toBeNull();
      expect(button('Download & Play')!.disabled).toBe(false);
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('shows the reason when the download cannot be started', async (): Promise<void> => {
      electronSpy('downloadUrl').mockRejectedValue(new Error('yt-dlp crashed'));

      await startDownload();

      expect(host.querySelector('.url-error')?.textContent).toBe('yt-dlp crashed');
      expect(button('Download & Play')!.disabled).toBe(false);
    });
  });

  // ==========================================================================
  // Window sizing
  // ==========================================================================

  describe('window sizing', (): void => {
    beforeEach(async (): Promise<void> => {
      await createDialog();
    });

    it('watches its own element for size changes', (): void => {
      expect(FakeResizeObserver.instances).toHaveLength(1);
      expect(FakeResizeObserver.instances[0].observed).toEqual([host]);
    });

    it('asks for the window to fit the content, rounding the height up', (): void => {
      vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({height: 240.2} as DOMRect);

      FakeResizeObserver.instances[0].notify();

      expect(electronSpy('setContentHeight')).toHaveBeenCalledExactlyOnceWith(241);
    });

    it('does not resize the window before a size change is reported', (): void => {
      expect(electronSpy('setContentHeight')).not.toHaveBeenCalled();
    });

    it('stops watching when destroyed', (): void => {
      fixture.destroy();

      expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
    });
  });
});
