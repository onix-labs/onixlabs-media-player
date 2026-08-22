/**
 * @fileoverview Attribute directive turning an element into a media drop target.
 *
 * The audio outlet, video outlet, playlist and layout outlet all accept dropped
 * media and all want the same behaviour: validate what is being dragged, show
 * accept/reject feedback, and add what is dropped with the standard auto-play
 * rules. That trio of handlers was copy-pasted into all four components; it
 * lives here instead so the behaviour cannot drift between surfaces.
 *
 * Applied to the element that should carry the feedback classes, which is not
 * always the component host:
 *
 * ```html
 * <div class="outlet" appFileDropTarget>...</div>
 * ```
 *
 * The `drag-over` and `drag-invalid` classes are set on that element, so the
 * existing component-scoped styles for them continue to apply unchanged.
 *
 * @module app/directives/file-drop-target
 */

import {Directive, inject, signal} from '@angular/core';
import {FileDropService} from '../services/file-drop.service';
import {ElectronService} from '../services/electron.service';

@Directive({
  selector: '[appFileDropTarget]',
  standalone: true,
  host: {
    '[class.drag-over]': 'isDragOver()',
    '[class.drag-invalid]': 'isDragInvalid()',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class FileDropTarget {
  /** File drop service for validating and extracting dragged media */
  private readonly fileDrop: FileDropService = inject(FileDropService);

  /** Electron service for adding the dropped files */
  private readonly electron: ElectronService = inject(ElectronService);

  /** Whether a drag carrying playable media is over the element */
  public readonly isDragOver: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /** Whether a drag carrying nothing playable is over the element */
  public readonly isDragInvalid: ReturnType<typeof signal<boolean>> = signal<boolean>(false);

  /**
   * Handles dragover to enable drop target.
   * Validates dragged files and shows appropriate visual feedback.
   *
   * @param event - The drag event
   */
  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const hasValid: boolean = this.fileDrop.hasValidFiles(event);
    this.isDragOver.set(hasValid);
    this.isDragInvalid.set(!hasValid);

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = hasValid ? 'copy' : 'none';
    }
  }

  /**
   * Handles dragleave to reset visual feedback.
   *
   * @param event - The drag event
   */
  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    this.isDragInvalid.set(false);
  }

  /**
   * Handles file drop to add media to the playlist with smart auto-play.
   *
   * Uses unified auto-play behavior:
   * - Single file: plays immediately
   * - Multiple files + empty playlist: plays from beginning
   * - Multiple files + existing playlist: appends without interrupting
   *
   * @param event - The drop event containing transferred files
   */
  public async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    this.isDragInvalid.set(false);

    const filePaths: string[] = this.fileDrop.extractMediaFilePaths(event);
    if (filePaths.length === 0) return;

    await this.electron.addFilesWithAutoPlay(filePaths);
  }
}
