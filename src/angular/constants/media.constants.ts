/**
 * @fileoverview Shared media-related constants.
 *
 * This module provides common constants used across multiple components
 * for media file handling and validation.
 *
 * @module app/constants/media.constants
 */

/**
 * Supported media file extensions for drag-and-drop filtering.
 * Files with other extensions are ignored when dropped.
 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3', '.mp4', '.m4v', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov',
  '.mid', '.midi'
]);
