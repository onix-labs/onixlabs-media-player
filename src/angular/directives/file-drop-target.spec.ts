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

import {describe, it, expect, beforeEach, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
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
