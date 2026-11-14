import { readFile, stat } from 'fs/promises';
import { parseMidiDuration, MIDI_FORMATS } from './midi-parser.js';

vi.mock('./logger.js', () => ({
  midiLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const mockedReadFile = vi.mocked(readFile);
const mockedStat = vi.mocked(stat);

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
}): Buffer<ArrayBuffer> {
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

/** End-of-track meta event at delta time 0: FF 2F 00. */
const END_OF_TRACK: readonly number[] = [0x00, 0xff, 0x2f, 0x00];

/**
 * Builds a Note On (channel 0, middle C) preceded by its delta time.
 *
 * @param delta - Ticks since the previous event
 */
function noteOn(delta: number): number[] {
  return [...encodeVariableLength(delta), 0x90, 0x3c, 0x64];
}

/**
 * Builds a Note Off (channel 0, middle C) preceded by its delta time.
 *
 * @param delta - Ticks since the previous event
 */
function noteOff(delta: number): number[] {
  return [...encodeVariableLength(delta), 0x80, 0x3c, 0x00];
}

/**
 * Builds a Set Tempo meta event (FF 51 03 tt tt tt) preceded by its delta time.
 *
 * @param delta - Ticks since the previous event
 * @param microsecondsPerBeat - The tempo
 */
function setTempo(delta: number, microsecondsPerBeat: number): number[] {
  return [
    ...encodeVariableLength(delta),
    0xff, 0x51, 0x03,
    (microsecondsPerBeat >> 16) & 0xff, (microsecondsPerBeat >> 8) & 0xff, microsecondsPerBeat & 0xff,
  ];
}

/**
 * Wraps raw event bytes in an MTrk chunk.
 *
 * @param events - The track's event bytes
 */
function trackChunk(events: readonly number[]): Buffer<ArrayBuffer> {
  const head: Buffer<ArrayBuffer> = Buffer.alloc(8);
  head.write('MTrk', 0, 'ascii');
  head.writeUInt32BE(events.length, 4);
  return Buffer.concat([head, Buffer.from(events)]);
}

/**
 * Builds a Standard MIDI File from the raw event bytes of each track, so a
 * test can spell out exactly the byte sequence it is about.
 *
 * @param tracks - Event bytes of each track, in file order
 * @param ticksPerBeat - The header's timing division
 * @param between - Bytes placed between the header and the first track
 */
function createMidiFile(tracks: readonly (readonly number[])[], ticksPerBeat: number = 480, between: readonly number[] = []): Buffer<ArrayBuffer> {
  const header: Buffer<ArrayBuffer> = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(tracks.length > 1 ? 1 : 0, 8);
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(ticksPerBeat, 12);
  return Buffer.concat([header, Buffer.from(between), ...tracks.map(trackChunk)]);
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
  beforeEach(() => {
    // Default: file size under the 10 MB limit
    mockedStat.mockResolvedValue({ size: 1024 } as Awaited<ReturnType<typeof stat>>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('valid MIDI files', () => {
    it('should parse a minimal MIDI file with default tempo (120 BPM)', async () => {
      // 960 ticks at 480 ticks/beat and 500000 us/beat (120 BPM) = 2 beats = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000, // 120 BPM
        maxTick: 960,  // 2 beats
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      // 960 ticks / 480 tpb = 2 beats. At 500000 us/beat = 1.0 seconds
      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should parse a MIDI file with 60 BPM tempo', async () => {
      // 60 BPM = 1000000 microseconds per beat
      // 480 ticks at 480 ticks/beat = 1 beat = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 1000000, // 60 BPM
        maxTick: 480,   // 1 beat
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should parse a MIDI file with 240 BPM tempo', async () => {
      // 240 BPM = 250000 microseconds per beat
      // 1920 ticks at 480 ticks/beat = 4 beats at 0.25 sec/beat = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 250000, // 240 BPM
        maxTick: 1920, // 4 beats
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should handle different ticks-per-beat values', async () => {
      // 96 ticks/beat, 500000 us/beat (120 BPM), 192 ticks = 2 beats = 1 second
      const buffer = createMidiBuffer({
        ticksPerBeat: 96,
        tempo: 500000,
        maxTick: 192,
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should correctly calculate longer durations', async () => {
      // 480 ticks/beat, 500000 us/beat (120 BPM), 4800 ticks = 10 beats = 5 seconds
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 4800,
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBeCloseTo(5.0, 5);
    });

    it('should return duration for a file with zero-length notes (zero maxTick)', async () => {
      // With maxTick=0, the only events are at tick 0, so duration should be 0
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 0,
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBe(0);
    });
  });

  describe('invalid and edge-case files', () => {
    it('should return 0 for a non-MIDI file (invalid header)', async () => {
      const buffer = Buffer.from('This is not a MIDI file at all');
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 for an empty buffer', async () => {
      const buffer = Buffer.alloc(0);
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/file.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 when the read fails (non-existent file)', async () => {
      mockedReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const duration = await parseMidiDuration('/fake/nonexistent.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 when the read fails with a generic error', async () => {
      mockedReadFile.mockRejectedValue(new Error('Permission denied'));

      const duration = await parseMidiDuration('/fake/no-permission.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 for SMPTE timing division (bit 15 set)', async () => {
      // SMPTE division has bit 15 set (e.g., 0x8000 | value)
      // The parser should return 0 for SMPTE timing
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 960,
      });

      // Overwrite the division field (bytes 12-13) to set SMPTE bit
      buffer.writeUInt16BE(0xe728, 12); // SMPTE: -25 frames/sec, 40 ticks/frame

      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/smpte.mid');

      expect(duration).toBe(0);
    });

    it('should return 0 for a buffer that is only the MThd header with no tracks', async () => {
      // Just the MThd header (14 bytes) with no MTrk chunks
      const buffer = Buffer.alloc(14);
      buffer.write('MThd', 0, 'ascii');
      buffer.writeUInt32BE(6, 4);    // header length
      buffer.writeUInt16BE(0, 8);    // format 0
      buffer.writeUInt16BE(1, 10);   // 1 track (but no track data)
      buffer.writeUInt16BE(480, 12); // ticks per beat

      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/header-only.mid');

      // No tracks to parse, so maxTick stays 0 => duration = 0
      expect(duration).toBe(0);
    });

    it('should handle a truncated MIDI header gracefully', async () => {
      // Only 6 bytes - enough for "MThd" + 2 more bytes, but not a complete header
      const buffer = Buffer.alloc(6);
      buffer.write('MThd', 0, 'ascii');
      buffer.writeUInt16BE(6, 4);

      mockedReadFile.mockResolvedValue(buffer);

      // This will attempt to read beyond buffer, but the while loop guard
      // (offset < buffer.length - 8) should prevent crashes
      const duration = await parseMidiDuration('/fake/truncated.mid');

      expect(duration).toBe(0);
    });
  });

  describe('file size limit', () => {
    it('should return 0 for files exceeding the 10 MB limit', async () => {
      mockedStat.mockResolvedValue({ size: 10 * 1024 * 1024 + 1 } as Awaited<ReturnType<typeof stat>>);

      const duration = await parseMidiDuration('/fake/huge.mid');

      expect(duration).toBe(0);
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('should parse files at exactly the 10 MB limit', async () => {
      mockedStat.mockResolvedValue({ size: 10 * 1024 * 1024 } as Awaited<ReturnType<typeof stat>>);
      const buffer = createMidiBuffer({ ticksPerBeat: 480, tempo: 500000, maxTick: 960 });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/at-limit.mid');

      expect(duration).toBeCloseTo(1.0, 5);
      expect(mockedReadFile).toHaveBeenCalled();
    });
  });

  describe('variable-length quantity encoding', () => {
    it('should handle large delta times encoded with multiple VLQ bytes', async () => {
      // maxTick = 16383 (0x3FFF) requires 2 VLQ bytes: [0xFF, 0x7F]
      // 16383 ticks / 480 tpb = 34.13125 beats at 500000 us/beat = 17.065625 seconds
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 16383,
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/large-delta.mid');

      const expected = (16383 / 480) * (500000 / 1000000);
      expect(duration).toBeCloseTo(expected, 4);
    });

    it('should handle very large delta times encoded with 3 VLQ bytes', async () => {
      // maxTick = 100000 requires 3 VLQ bytes
      const buffer = createMidiBuffer({
        ticksPerBeat: 480,
        tempo: 500000,
        maxTick: 100000,
      });
      mockedReadFile.mockResolvedValue(buffer);

      const duration = await parseMidiDuration('/fake/very-large-delta.mid');

      const expected = (100000 / 480) * (500000 / 1000000);
      expect(duration).toBeCloseTo(expected, 4);
    });
  });

  // All of the following use 480 ticks per beat and, unless a tempo event says
  // otherwise, the default 120 BPM: 480 ticks is half a second.

  describe('tempo map', () => {
    it('should assume 120 BPM when the file has no tempo event', async () => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[...noteOn(0), ...noteOff(960), ...END_OF_TRACK]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/no-tempo.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should time each section at the tempo in force when the tempo changes mid-file', async () => {
      // One beat at 120 BPM (0.5 s), then one beat at 60 BPM (1 s).
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        ...setTempo(0, 500000),
        ...noteOn(0),
        ...setTempo(480, 1000000),
        ...noteOff(480),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/tempo-change.mid');

      expect(duration).toBeCloseTo(1.5, 5);
    });

    it('should apply a tempo change at the tick where it occurs, before the first one', async () => {
      // No tempo until tick 480, so the first beat runs at the default 120 BPM
      // (0.5 s) and the second at 30 BPM (2 s).
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        ...noteOn(0),
        ...setTempo(480, 2000000),
        ...noteOff(480),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/late-tempo.mid');

      expect(duration).toBeCloseTo(2.5, 5);
    });

    it('should ignore a tempo event whose length is not three bytes', async () => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        0x00, 0xff, 0x51, 0x02, 0x0f, 0x42, // malformed: two data bytes
        ...noteOn(0),
        ...noteOff(960),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/bad-tempo.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });
  });

  describe('multiple tracks', () => {
    it('should take the duration from the longest track', async () => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([
        [...noteOn(0), ...noteOff(480), ...END_OF_TRACK],
        [...noteOn(0), ...noteOff(1920), ...END_OF_TRACK],
        [...noteOn(0), ...noteOff(960), ...END_OF_TRACK],
      ]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/three-tracks.mid');

      expect(duration).toBeCloseTo(2.0, 5);
    });

    it('should apply the tempo track to the ticks of the other tracks', async () => {
      // Format 1: the first track holds only the tempo map. One beat at 60 BPM
      // (1 s), then two beats at 240 BPM (0.5 s).
      const buffer: Buffer<ArrayBuffer> = createMidiFile([
        [...setTempo(0, 1000000), ...setTempo(480, 250000), ...END_OF_TRACK],
        [...noteOn(0), ...noteOff(1440), ...END_OF_TRACK],
      ]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/format-1.mid');

      expect(duration).toBeCloseTo(1.5, 5);
    });

    it('should order tempo changes by tick when they come from different tracks', async () => {
      // The later change (tick 960) is in the first track and the earlier one
      // (tick 480) in the second: 0.5 s at 120 BPM, 1 s at 60 BPM, then one
      // beat at 240 BPM (0.25 s).
      const buffer: Buffer<ArrayBuffer> = createMidiFile([
        [...setTempo(960, 250000), ...END_OF_TRACK],
        [...setTempo(480, 1000000), ...noteOff(960), ...END_OF_TRACK],
      ]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/interleaved-tempo.mid');

      expect(duration).toBeCloseTo(1.75, 5);
    });

    it('should find a track that follows a chunk it does not recognise', async () => {
      const unknownChunk: number[] = [0x58, 0x46, 0x49, 0x48, 0x00, 0x00, 0x00, 0x02, 0x01, 0x02]; // "XFIH", 2 bytes
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[...noteOn(0), ...noteOff(960), ...END_OF_TRACK]], 480, unknownChunk);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/extra-chunk.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });
  });

  describe('event framing', () => {
    it('should follow running status when consecutive events omit the status byte', async () => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        ...noteOn(0),
        0x83, 0x60, 0x3e, 0x64, // delta 480, then note + velocity only
        0x83, 0x60, 0x40, 0x64, // and again
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/running-status.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should follow running status for an event with a single data byte', async () => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        0x00, 0xc0, 0x05,       // program change
        0x83, 0x60, 0x06,       // delta 480, then the program number only
        0x83, 0x60, 0x07,       // and again
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/running-program-change.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should skip a data byte that has no earlier status to run from', async () => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        0x00, 0x3c, // a data byte where a status byte belongs
        ...noteOn(480),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/stray-data-byte.mid');

      expect(duration).toBeCloseTo(0.5, 5);
    });

    // In each case a 480-tick Note Off follows the event. Reading the wrong
    // number of data bytes would swallow part of that delta time and change
    // the result.
    it.each([
      {name: 'polyphonic aftertouch', bytes: [0xa0, 0x3c, 0x40]},
      {name: 'control change', bytes: [0xb0, 0x07, 0x64]},
      {name: 'pitch bend', bytes: [0xe0, 0x00, 0x40]},
      {name: 'program change', bytes: [0xc0, 0x05]},
      {name: 'channel pressure', bytes: [0xd0, 0x40]},
      {name: 'a system real-time message', bytes: [0xf8]},
    ])('should step over $name by its own length', async ({bytes}: {bytes: number[]}) => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[0x00, ...bytes, ...noteOff(480), ...END_OF_TRACK]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/channel-event.mid');

      expect(duration).toBeCloseTo(0.5, 5);
    });

    it.each([
      {name: 'a sysex event (F0)', status: 0xf0},
      {name: 'a sysex escape (F7)', status: 0xf7},
    ])('should step over the payload of $name', async ({status}: {status: number}) => {
      // The payload is a complete Set Tempo event; were it read as events
      // rather than skipped, it would quadruple the duration.
      const payload: number[] = setTempo(0, 2000000);
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        0x00, status, payload.length, ...payload,
        ...noteOff(480),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/sysex.mid');

      expect(duration).toBeCloseTo(0.5, 5);
    });

    it('should read a sysex length that spans several bytes', async () => {
      const payload: number[] = Array<number>(200).fill(0x7f);
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        0x00, 0xf0, ...encodeVariableLength(payload.length), ...payload,
        ...noteOff(480),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/long-sysex.mid');

      expect(duration).toBeCloseTo(0.5, 5);
    });

    it('should step over a meta event by its length', async () => {
      const text: number[] = [...Buffer.from('Piano', 'ascii')];
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[
        0x00, 0xff, 0x03, text.length, ...text, // track name
        ...noteOff(480),
        ...END_OF_TRACK,
      ]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/track-name.mid');

      expect(duration).toBeCloseTo(0.5, 5);
    });
  });

  describe('malformed and truncated tracks', () => {
    it('should read no more than four bytes of an over-long delta time', async () => {
      // Four bytes that all ask for another; the largest value four can carry.
      const buffer: Buffer<ArrayBuffer> = createMidiFile([[0xff, 0xff, 0xff, 0xff, 0x90, 0x3c, 0x64, ...END_OF_TRACK]]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/long-delta.mid');

      expect(duration).toBeCloseTo((0x0fffffff / 480) * 0.5, 3);
    });

    // The track announces more bytes than the file holds. Each file ends
    // somewhere after a 480-tick delta time, which must still be counted.
    it.each([
      {name: 'straight after a delta time', tail: []},
      {name: 'after a meta status byte', tail: [0xff]},
      {name: 'after a meta type byte', tail: [0xff, 0x51]},
      {name: 'inside a tempo event', tail: [0xff, 0x51, 0x03, 0x07]},
      {name: 'after a sysex status byte', tail: [0xf0]},
    ])('should keep the ticks read so far when the file ends $name', async ({tail}: {tail: number[]}) => {
      const events: number[] = [...noteOn(0), 0x83, 0x60, ...tail];
      const whole: Buffer<ArrayBuffer> = createMidiFile([[...events, ...Array<number>(16).fill(0x00)]]);
      const buffer: Buffer<ArrayBuffer> = whole.subarray(0, whole.length - 16);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/truncated-track.mid');

      expect(duration).toBeCloseTo(0.5, 5);
    });

    it.each([
      {name: 'meta event', event: [0xff, 0x01]},
      {name: 'sysex event', event: [0xf0]},
    ])('should still read the next track after a $name with an over-long length', async ({event}: {event: number[]}) => {
      const buffer: Buffer<ArrayBuffer> = createMidiFile([
        [0x83, 0x60, ...event, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00],
        [...noteOn(0), ...noteOff(960), ...END_OF_TRACK],
      ]);
      mockedReadFile.mockResolvedValue(buffer);

      const duration: number = await parseMidiDuration('/fake/long-length.mid');

      expect(duration).toBeCloseTo(1.0, 5);
    });

    it('should return 0 when the file cannot be inspected', async () => {
      mockedStat.mockRejectedValue(new Error('EACCES: permission denied'));

      const duration: number = await parseMidiDuration('/fake/unreadable.mid');

      expect(duration).toBe(0);
      expect(mockedReadFile).not.toHaveBeenCalled();
    });
  });
});
