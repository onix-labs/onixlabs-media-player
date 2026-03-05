/**
 * @fileoverview MIDI file parser for extracting duration from Standard MIDI Files.
 *
 * Parses the binary structure defined by the MIDI 1.0 specification to calculate
 * total playback duration in seconds. Handles multi-track files (format 0 and 1),
 * variable-length delta times, and tempo change meta events.
 *
 * @see {@link https://www.midi.org/specifications/file-format-specifications/standard-midi-files Standard MIDI Files Specification}
 * @see {@link https://www.midi.org/specifications/midi1-specifications MIDI 1.0 Detailed Specification}
 *
 * @module electron/midi-parser
 */

import { readFileSync, statSync } from 'fs';
import { midiLogger } from './logger.js';

export const MIDI_FORMATS: Set<string> = new Set(['.mid', '.midi']);

/** Maximum MIDI file size (10 MB) to prevent excessive memory allocation. */
const MAX_MIDI_FILE_SIZE: number = 10 * 1024 * 1024;

/**
 * Parses a Standard MIDI File and calculates total playback duration.
 *
 * Reads the MThd header to extract timing division (ticks per beat),
 * then iterates all MTrk track chunks to find the maximum tick and
 * any tempo change meta events (0xFF 0x51). Converts the tick count
 * to seconds using the accumulated tempo map.
 *
 * SMPTE-based timing division is not supported and returns 0.
 *
 * @param filePath - Absolute path to the MIDI file
 * @returns Duration in seconds, or 0 if the file cannot be parsed
 */
export function parseMidiDuration(filePath: string): number {
  try {
    const fileSize: number = statSync(filePath).size;
    if (fileSize > MAX_MIDI_FILE_SIZE) {
      midiLogger.warn(`MIDI file too large (${fileSize} bytes), skipping parse`);
      return 0;
    }

    const buffer: Buffer = readFileSync(filePath);
    let offset: number = 0;

    // Verify MIDI header "MThd"
    if (buffer.toString('ascii', 0, 4) !== 'MThd') {
      return 0;
    }
    offset += 8; // Skip "MThd" + header length

    // Read format (2 bytes), numTracks (2 bytes), division (2 bytes)
    const division: number = buffer.readUInt16BE(offset + 4);
    offset += 6;

    // Check if division is SMPTE (negative) or ticks per beat (positive)
    const ticksPerBeat: number = division & 0x8000 ? 0 : division;
    if (ticksPerBeat === 0) {
      return 0; // SMPTE timing not supported
    }

    let maxTick: number = 0;
    const tempoChanges: Array<{ tick: number; tempo: number }> = [{ tick: 0, tempo: 500000 }]; // Default 120 BPM

    // Parse all tracks
    while (offset < buffer.length - 8) {
      // Look for track chunk "MTrk"
      if (buffer.toString('ascii', offset, offset + 4) !== 'MTrk') {
        offset++;
        continue;
      }
      offset += 4;

      const trackLength: number = buffer.readUInt32BE(offset);
      offset += 4;

      const trackEnd: number = offset + trackLength;
      let currentTick: number = 0;

      let runningStatus: number = 0; // Track running status for channel messages

      // Parse track events
      while (offset < trackEnd && offset < buffer.length) {
        // Read variable-length delta time (max 4 bytes per MIDI spec)
        let deltaTime: number = 0;
        let byte: number;
        let varLenBytes: number = 0;
        do {
          if (varLenBytes >= 4) break; // MIDI variable-length values are max 4 bytes
          byte = buffer[offset++];
          deltaTime = (deltaTime << 7) | (byte & 0x7f);
          varLenBytes++;
        } while (byte & 0x80 && offset < trackEnd);

        currentTick += deltaTime;

        if (offset >= buffer.length) break;

        let eventType: number = buffer[offset];

        // Check for running status: if high bit is not set, use previous status
        if ((eventType & 0x80) === 0) {
          // Running status - reuse last channel message status
          if (runningStatus === 0) {
            // No previous status, skip this byte and continue
            offset++;
            continue;
          }
          eventType = runningStatus;
          // Don't increment offset - the byte we read is data, not status
        } else {
          // Normal status byte - consume it
          offset++;
          // Update running status for channel messages (0x80-0xEF)
          if (eventType >= 0x80 && eventType < 0xf0) {
            runningStatus = eventType;
          } else {
            // System messages (0xF0-0xFF) clear running status
            runningStatus = 0;
          }
        }

        // Meta event (0xFF)
        if (eventType === 0xff) {
          if (offset >= buffer.length) break;
          const metaType: number = buffer[offset++];

          // Read variable-length length (max 4 bytes per MIDI spec)
          let length: number = 0;
          let lengthBytes: number = 0;
          do {
            if (offset >= buffer.length || lengthBytes >= 4) break;
            byte = buffer[offset++];
            length = (length << 7) | (byte & 0x7f);
            lengthBytes++;
          } while (byte & 0x80);

          // Tempo change (meta type 0x51) - 3 bytes: microseconds per quarter note
          if (metaType === 0x51 && length === 3 && offset + 3 <= buffer.length) {
            const tempo: number = (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
            tempoChanges.push({ tick: currentTick, tempo });
          }

          offset += length;
        }
        // SysEx event (0xF0 or 0xF7)
        else if (eventType === 0xf0 || eventType === 0xf7) {
          let length: number = 0;
          let sysexLenBytes: number = 0;
          do {
            if (offset >= buffer.length || sysexLenBytes >= 4) break;
            byte = buffer[offset++];
            length = (length << 7) | (byte & 0x7f);
            sysexLenBytes++;
          } while (byte & 0x80);
          offset += length;
        }
        // Channel event (0x80-0xEF)
        else {
          const highNibble: number = eventType & 0xf0;
          // Events with 2 data bytes: note on/off, aftertouch, control, pitch bend
          if (highNibble === 0x80 || highNibble === 0x90 || highNibble === 0xa0 ||
              highNibble === 0xb0 || highNibble === 0xe0) {
            offset += 2;
          }
          // Events with 1 data byte: program change, channel pressure
          else if (highNibble === 0xc0 || highNibble === 0xd0) {
            offset += 1;
          }
        }
      }

      maxTick = Math.max(maxTick, currentTick);
      offset = trackEnd;
    }

    // Convert ticks to seconds using tempo changes
    tempoChanges.sort((a: {tick: number; tempo: number}, b: {tick: number; tempo: number}): number => a.tick - b.tick);

    let totalSeconds: number = 0;
    let lastTick: number = 0;
    let currentTempo: number = 500000; // microseconds per beat (120 BPM default)

    for (const change of tempoChanges) {
      if (change.tick > lastTick) {
        const ticksDelta: number = change.tick - lastTick;
        totalSeconds += (ticksDelta / ticksPerBeat) * (currentTempo / 1000000);
      }
      currentTempo = change.tempo;
      lastTick = change.tick;
    }

    // Add remaining time after last tempo change
    if (maxTick > lastTick) {
      const ticksDelta: number = maxTick - lastTick;
      totalSeconds += (ticksDelta / ticksPerBeat) * (currentTempo / 1000000);
    }

    return totalSeconds;
  } catch (err) {
    midiLogger.error(`Failed to parse MIDI duration: ${err}`);
    return 0;
  }
}
