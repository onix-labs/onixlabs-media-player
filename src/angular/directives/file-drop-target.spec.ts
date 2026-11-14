/**
 * @fileoverview Tests for the FileDropTarget directive.
 *
 * These cover the drag-and-drop behaviour that used to be copy-pasted into the
 * audio outlet, video outlet, playlist and layout outlet, and was previously
 * tested twice over against two of those components. Testing the directive
 * once covers all four surfaces.
 *
 * @module app/directives/file-drop-target.spec
 */

import {Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {FileDropTarget} from './file-drop-target';
import {FileDropService} from '../services/file-drop.service';
import {ElectronService} from '../services/electron.service';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock DragEvent with preventDefault/stopPropagation stubs.
 *
 * @returns A DragEvent-shaped object for testing
 */
function createDragEvent(): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {files: {length: 0} as FileList},
  } as unknown as DragEvent;
}

/**
 * Creates a mock FileDropService.
 *
 * @returns A stubbed FileDropService
 */
function createMockFileDropService(): Record<string, unknown> {
  return {
    extractMediaFilePaths: vi.fn().mockReturnValue([]),
    hasValidFiles: vi.fn().mockReturnValue(true),
  };
}

/**
 * Creates a mock ElectronService.
 *
 * @returns A stubbed ElectronService
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    addFilesWithAutoPlay: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('FileDropTarget', (): void => {
  let directive: FileDropTarget;
  let mockFileDrop: ReturnType<typeof createMockFileDropService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;

  beforeEach((): void => {
    mockFileDrop = createMockFileDropService();
    mockElectron = createMockElectronService();

    TestBed.configureTestingModule({
      providers: [
        FileDropTarget,
        {provide: FileDropService, useValue: mockFileDrop},
        {provide: ElectronService, useValue: mockElectron},
      ],
    });

    directive = TestBed.inject(FileDropTarget);
  });

  // ==========================================================================
  // Initial State
  // ==========================================================================

  describe('initial state', (): void => {
    it('isDragOver defaults to false', (): void => {
      expect(directive.isDragOver()).toBe(false);
    });

    it('isDragInvalid defaults to false', (): void => {
      expect(directive.isDragInvalid()).toBe(false);
    });
  });

  // ==========================================================================
  // Drag Over
  // ==========================================================================

  describe('onDragOver', (): void => {
    it('marks valid files as accepted', (): void => {
      const event: DragEvent = createDragEvent();

      directive.onDragOver(event);

      expect(directive.isDragOver()).toBe(true);
      expect(directive.isDragInvalid()).toBe(false);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('marks invalid files as rejected', (): void => {
      (mockFileDrop['hasValidFiles'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const event: DragEvent = createDragEvent();

      directive.onDragOver(event);

      expect(directive.isDragOver()).toBe(false);
      expect(directive.isDragInvalid()).toBe(true);
    });

    it('sets the copy drop effect for valid files', (): void => {
      const event: DragEvent = createDragEvent();

      directive.onDragOver(event);

      expect(event.dataTransfer?.dropEffect).toBe('copy');
    });

    it('sets the none drop effect for invalid files', (): void => {
      (mockFileDrop['hasValidFiles'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const event: DragEvent = createDragEvent();

      directive.onDragOver(event);

      expect(event.dataTransfer?.dropEffect).toBe('none');
    });
  });

  // ==========================================================================
  // Drag Leave
  // ==========================================================================

  describe('onDragLeave', (): void => {
    it('clears both feedback states', (): void => {
      directive.isDragOver.set(true);
      directive.isDragInvalid.set(true);
      const event: DragEvent = createDragEvent();

      directive.onDragLeave(event);

      expect(directive.isDragOver()).toBe(false);
      expect(directive.isDragInvalid()).toBe(false);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // Drop
  // ==========================================================================

  describe('onDrop', (): void => {
    it('clears feedback and adds the dropped files', async (): Promise<void> => {
      directive.isDragOver.set(true);
      const event: DragEvent = createDragEvent();
      const filePaths: string[] = ['/music/song.mp3', '/music/video.mp4'];
      (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue(filePaths);

      await directive.onDrop(event);

      expect(directive.isDragOver()).toBe(false);
      expect(directive.isDragInvalid()).toBe(false);
      expect(mockFileDrop['extractMediaFilePaths']).toHaveBeenCalledWith(event);
      expect(mockElectron['addFilesWithAutoPlay']).toHaveBeenCalledWith(filePaths);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('does nothing when no media was dropped', async (): Promise<void> => {
      directive.isDragOver.set(true);
      const event: DragEvent = createDragEvent();
      (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue([]);

      await directive.onDrop(event);

      expect(directive.isDragOver()).toBe(false);
      expect(mockElectron['addFilesWithAutoPlay']).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Applied to an element
// ============================================================================

/** Hosts the directive on a plain element, as the outlets and playlist do. */
@Component({
  imports: [FileDropTarget],
  template: '<div class="zone" appFileDropTarget></div>',
})
class DropZoneHost {}

describe('FileDropTarget on an element', (): void => {
  let fixture: ComponentFixture<DropZoneHost>;
  let zone: HTMLElement;
  let mockFileDrop: ReturnType<typeof createMockFileDropService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;

  /**
   * Dispatches a drag event on the drop zone.
   *
   * @param type - The drag event type
   * @param dataTransfer - The transfer payload, or null for a drag without one
   * @returns The dispatched event, for inspection
   */
  async function dispatchDrag(type: string, dataTransfer: {dropEffect: string} | null = {dropEffect: ''}): Promise<Event> {
    const event: Event = new Event(type, {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'dataTransfer', {value: dataTransfer});
    zone.dispatchEvent(event);
    await fixture.whenStable();
    return event;
  }

  beforeEach(async (): Promise<void> => {
    mockFileDrop = createMockFileDropService();
    mockElectron = createMockElectronService();

    TestBed.configureTestingModule({
      imports: [DropZoneHost],
      providers: [
        {provide: FileDropService, useValue: mockFileDrop},
        {provide: ElectronService, useValue: mockElectron},
      ],
    });

    fixture = TestBed.createComponent(DropZoneHost);
    zone = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.zone')!;
    await fixture.whenStable();
  });

  it('shows no drag feedback at rest', (): void => {
    expect(zone.classList.contains('drag-over')).toBe(false);
    expect(zone.classList.contains('drag-invalid')).toBe(false);
  });

  it('highlights the element while playable files are dragged over it', async (): Promise<void> => {
    await dispatchDrag('dragover');

    expect(zone.classList.contains('drag-over')).toBe(true);
    expect(zone.classList.contains('drag-invalid')).toBe(false);
  });

  it('marks the element as refusing the drag when nothing playable is dragged over it', async (): Promise<void> => {
    (mockFileDrop['hasValidFiles'] as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await dispatchDrag('dragover');

    expect(zone.classList.contains('drag-invalid')).toBe(true);
    expect(zone.classList.contains('drag-over')).toBe(false);
  });

  it('tells the browser a copy is on offer for playable files', async (): Promise<void> => {
    const dataTransfer: {dropEffect: string} = {dropEffect: ''};

    await dispatchDrag('dragover', dataTransfer);

    expect(dataTransfer.dropEffect).toBe('copy');
  });

  it('tells the browser nothing can be dropped for unplayable files', async (): Promise<void> => {
    (mockFileDrop['hasValidFiles'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const dataTransfer: {dropEffect: string} = {dropEffect: ''};

    await dispatchDrag('dragover', dataTransfer);

    expect(dataTransfer.dropEffect).toBe('none');
  });

  it('still gives feedback for a drag that carries no transfer data', async (): Promise<void> => {
    await dispatchDrag('dragover', null);

    expect(zone.classList.contains('drag-over')).toBe(true);
  });

  it('claims the dragover so the browser allows a drop and outer targets stay quiet', async (): Promise<void> => {
    let reachedOuter: boolean = false;
    (fixture.nativeElement as HTMLElement).addEventListener('dragover', (): void => {
      reachedOuter = true;
    });

    const event: Event = await dispatchDrag('dragover');

    expect(event.defaultPrevented).toBe(true);
    expect(reachedOuter).toBe(false);
  });

  it('removes the feedback when the drag leaves', async (): Promise<void> => {
    await dispatchDrag('dragover');

    await dispatchDrag('dragleave');

    expect(zone.classList.contains('drag-over')).toBe(false);
    expect(zone.classList.contains('drag-invalid')).toBe(false);
  });

  it('removes the refusal feedback when the drag leaves', async (): Promise<void> => {
    (mockFileDrop['hasValidFiles'] as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await dispatchDrag('dragover');

    await dispatchDrag('dragleave');

    expect(zone.classList.contains('drag-invalid')).toBe(false);
  });

  it('adds the dropped media files with auto-play', async (): Promise<void> => {
    (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue(['/music/a.mp3', '/music/b.mp3']);

    await dispatchDrag('drop');

    expect(mockElectron['addFilesWithAutoPlay']).toHaveBeenCalledExactlyOnceWith(['/music/a.mp3', '/music/b.mp3']);
  });

  it('adds nothing when the drop holds no playable files', async (): Promise<void> => {
    await dispatchDrag('drop');

    expect(mockElectron['addFilesWithAutoPlay']).not.toHaveBeenCalled();
  });

  it('removes the feedback on drop and keeps the browser from opening the file', async (): Promise<void> => {
    await dispatchDrag('dragover');

    const event: Event = await dispatchDrag('drop');

    expect(zone.classList.contains('drag-over')).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });
});
