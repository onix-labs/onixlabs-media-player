import { readFileSync } from 'fs';
import { parseMidiDuration, MIDI_FORMATS } from './midi-parser.js';

vi.mock('./logger.js', () => ({
  midiLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

const mockedReadFileSync = vi.mocked(readFileSync);

/**
 * Creates a minimal valid MIDI file buffer in memory.
 *
 * MIDI file structure:
 *   MThd (4 bytes) + header length (4 bytes, always 6) +
 *   format (2 bytes) + numTracks (2 bytes) + division (2 bytes) +
 *   MTrk chunks...
 *
 * Each MTrk chunk:
 *   MTrk (4 bytes) + track length (4 bytes) + track events...
 */
function createMidiBuffer(options: {
  ticksPerBeat?: number;
  tempo?: number;
  maxTick?: number;
  format?: number;
  numTracks?: number;
}): Buffer {
  const {
    ticksPerBeat = 480,
    tempo = 500000,
    maxTick = 960,
    format = 0,
    numTracks = 1,
  } = options;

  // Build track data first so we know its length
  const trackEvents: number[] = [];

  // Delta time 0, then tempo meta event: FF 51 03 <3 bytes tempo>
  trackEvents.push(0x00); // delta time = 0
  trackEvents.push(0xff); // meta event
  trackEvents.push(0x51); // tempo type
  trackEvents.push(0x03); // length = 3
  trackEvents.push((tempo >> 16) & 0xff);
  trackEvents.push((tempo >> 8) & 0xff);
  trackEvents.push(tempo & 0xff);

  // Note On event at delta time 0: 90 3C 64 (channel 0, middle C, velocity 100)
  trackEvents.push(0x00); // delta time = 0
  trackEvents.push(0x90); // note on, channel 0
  trackEvents.push(0x3c); // note: middle C
  trackEvents.push(0x64); // velocity: 100

  // Note Off event at delta time = maxTick: 80 3C 00
  // Encode maxTick as variable-length quantity
  const vlqBytes = encodeVariableLength(maxTick);
  trackEvents.push(...vlqBytes);
  trackEvents.push(0x80); // note off, channel 0
  trackEvents.push(0x3c); // note: middle C
  trackEvents.push(0x00); // velocity: 0

  // End of track meta event: delta 0, FF 2F 00
  trackEvents.push(0x00); // delta time = 0
  trackEvents.push(0xff); // meta event
  trackEvents.push(0x2f); // end of track
  trackEvents.push(0x00); // length = 0

  const trackDataLength = trackEvents.length;

  // MThd header: 14 bytes
  // MTrk header: 8 bytes + track data
  const totalLength = 14 + 8 + trackDataLength;
  const buffer = Buffer.alloc(totalLength);
  let offset = 0;

  // MThd header
  buffer.write('MThd', offset, 'ascii');
  offset += 4;
  buffer.writeUInt32BE(6, offset); // header length = 6
  offset += 4;
  buffer.writeUInt16BE(format, offset); // format
  offset += 2;
  buffer.writeUInt16BE(numTracks, offset); // number of tracks
  offset += 2;
  buffer.writeUInt16BE(ticksPerBeat, offset); // division (ticks per beat)
  offset += 2;

  // MTrk chunk
  buffer.write('MTrk', offset, 'ascii');
  offset += 4;
  buffer.writeUInt32BE(trackDataLength, offset);
  offset += 4;

  // Write track events
  for (const byte of trackEvents) {
    buffer[offset++] = byte;
  }

  return buffer;
}

/**
 * Encodes an integer as a MIDI variable-length quantity (VLQ).
 */
function encodeVariableLength(value: number): number[] {
  if (value < 0) return [0];
  if (value === 0) return [0x00];

  const bytes: number[] = [];
  let v = value;

  bytes.unshift(v & 0x7f);
  v >>= 7;

  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }

  return bytes;
}

describe('MIDI_FORMATS', () => {
  it('should contain .mid extension', () => {
    expect(MIDI_FORMATS.has('.mid')).toBe(true);
  });

  it('should contain .midi extension', () => {
    expect(MIDI_FORMATS.has('.midi')).toBe(true);
  });

  it('should not contain unrelated extensions', () => {
    expect(MIDI_FORMATS.has('.mp3')).toBe(false);
    expect(MIDI_FORMATS.has('.wav')).toBe(false);
    expect(MIDI_FORMATS.has('.mid3')).toBe(false);
  });

  it('should have exactly 2 entries', () => {
    expect(MIDI_FORMATS.size).toBe(2);
  });
});

describe('parseMidiDuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('valid MIDI files', () => {
    it('should parse a minimal MIDI file with default tempo (120 BPM)', () => {
      // 960 ticks at 480 ticks/beat and 500000 us/beat (120 BPM) = 2 beats = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000, // 120 BPM
        maxTick: 960,  // 2 beats
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      // 960 ticks / 480 tpb = 2 beats. At 500000 us/beat = 1.0 seconds
      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should parse a MIDI file with 60 BPM tempo', () => {
      // 60 BPM = 1000000 microseconds per beat
      // 480 ticks at 480 ticks/beat = 1 beat = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 1000000, // 60 BPM
        maxTick: 480,   // 1 beat
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should parse a MIDI file with 240 BPM tempo', () => {
      // 240 BPM = 250000 microseconds per beat
      // 1920 ticks at 480 ticks/beat = 4 beats at 0.25 sec/beat = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 250000, // 240 BPM
        maxTick: 1920, // 4 beats
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should handle different ticks-per-beat values', () => {
      // 96 ticks/beat, 500000 us/beat (120 BPM), 192 ticks = 2 beats = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 96,
        tempo: 500000,
        maxTick: 192,
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should correctly calculate longer durations', () => {
      // 480 ticks/beat, 500000 us/beat (120 BPM), 4800 ticks = 10 beats = 5 seconds
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 4800,
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(5.0, 5);
    });

    it('should return duration for a file with zero-length notes (zero maxTick)', () => {
      // With maxTick=0, the only events are at tick 0, so duration should be 0
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 0,
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBe(0);
    });
  });

  describe('invalid and edge-case files', () => {
    it('should return 0 for a non-MIDI file (invalid header)', () => {
      const buffer = Buffer.from('This is not a MIDI file at all');
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 for an empty buffer', () => {
      const buffer = Buffer.alloc(0);
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/file.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 when readFileSync throws (non-existent file)', () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const duration = parseMidiDuration('/fake/nonexistent.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 when readFileSync throws a generic error', () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const duration = parseMidiDuration('/fake/no-permission.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 for SMPTE timing division (bit 15 set)', () => {
      // SMPTE division has bit 15 set (e.g., 0x8000 | value)
      // The parser should return 0 for SMPTE timing
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 960,
      });

      // Overwrite the division field (bytes 12-13) to set SMPTE bit
      buffer.writeUInt16BE(0xe728, 12); // SMPTE: -25 frames/sec, 40 ticks/frame

      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/smpte.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 for a buffer that is only the MThd header with no tracks', () => {
      // Just the MThd header (14 bytes) with no MTrk chunks
      const buffer = Buffer.alloc(14);
      buffer.write('MThd', 0, 'ascii');
      buffer.writeUInt32BE(6, 4);    // header length
      buffer.writeUInt16BE(0, 8);    // format 0
      buffer.writeUInt16BE(1, 10);   // 1 track (but no track data)
      buffer.writeUInt16BE(480, 12); // ticks per beat

      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/header-only.mid');

      // No tracks to parse, so maxTick stays 0 => duration = 0
      expect(duration).toBe(0);
    });

    it('should handle a truncated MIDI header gracefully', () => {
      // Only 6 bytes - enough for "MThd" + 2 more bytes, but not a complete header
      const buffer = Buffer.alloc(6);
      buffer.write('MThd', 0, 'ascii');
      buffer.writeUInt16BE(6, 4);

      mockedReadFileSync.mockReturnValue(buffer);

      // This will attempt to read beyond buffer, but the while loop guard
      // (offset < buffer.length - 8) should prevent crashes
      const duration = parseMidiDuration('/fake/truncated.mid');

      expect(duration).toBe(0);
    });
  });

  describe('variable-length quantity encoding', () => {
    it('should handle large delta times encoded with multiple VLQ bytes', () => {
      // maxTick = 16383 (0x3FFF) requires 2 VLQ bytes: [0xFF, 0x7F]
      // 16383 ticks / 480 tpb = 34.13125 beats at 500000 us/beat = 17.065625 seconds
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 16383,
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/large-delta.mid');

      const expected = (16383 / 480) * (500000 / 1000000);
      expect(duration).toBeCloseTo(expected, 4);
    });

    it('should handle very large delta times encoded with 3 VLQ bytes', () => {
      // maxTick = 100000 requires 3 VLQ bytes
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 100000,
      });
      mockedReadFileSync.mockReturnValue(buffer);

      const duration = parseMidiDuration('/fake/very-large-delta.mid');

      const expected = (100000 / 480) * (500000 / 1000000);
      expect(duration).toBeCloseTo(expected, 4);
    });
  });
});
