/**
 * @fileoverview Tests for OpenUrlDialog.
 *
 * Tests cover:
 * - fetchInfo success, failure and the re-entry guard
 * - Quality defaulting to the highest available format
 * - submit() in both stream and download modes, including failure handling
 * - The effect that reacts to the active download job completing or failing
 * - Cancellation and the small form setters
 *
 * @module app/components/open-url-dialog.spec
 */

import {TestBed} from '@angular/core/testing';
import {ElementRef, signal, type WritableSignal} from '@angular/core';
import {OpenUrlDialog} from './open-url-dialog';
import {ElectronService, type UrlMediaInfo, type DownloadJob} from '../../services/electron.service';
import {DependencyService} from '../../services/dependency.service';

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

    it('passes the selected format id for video', async (): Promise<void> => {
      component.selectedFormatId.set('fmt-720');

      await component.submit();

      expect(mockElectron['downloadUrl']).toHaveBeenCalledWith(
        'https://example.com/v', 'video', 'fmt-720', 'A Video'
      );
    });

    it('never passes a format id for audio', async (): Promise<void> => {
      component.mediaFormat.set('audio');
      component.selectedFormatId.set('fmt-720');

      await component.submit();

      expect(mockElectron['downloadUrl']).toHaveBeenCalledWith(
        'https://example.com/v', 'audio', null, 'A Video'
      );
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

    it('opens the dependency settings on the right pane', (): void => {
      component.openDependencySettings();

      expect(mockElectron['showConfigurationWindow']).toHaveBeenCalledWith('dependencies');
    });
  });
});
