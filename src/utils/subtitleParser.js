/**
 * subtitleParser.js
 * ─────────────────────────────────────────────────────────────
 * Converts raw .srt / .vtt subtitle content into clean,
 * readable prose. Removes:
 *   - index numbers (1, 2, 3 ...)
 *   - timestamp lines (00:01:15,120 --> 00:01:18,400)
 *   - WebVTT headers (WEBVTT, STYLE, NOTE, REGION blocks)
 *   - HTML-like styling tags (<i>, <b>, <font>, <c>, <u>, <00:00:01.000>)
 *
 * Output: a continuous flow of paragraphs. A blank line in the
 * source between two cue blocks that are NOT adjacent in time
 * is preserved as a paragraph break (topic/speaker change).
 * ─────────────────────────────────────────────────────────────
 */

// Matches a full timestamp line, both SRT and VTT styles.
//   SRT:  00:01:15,120 --> 00:01:18,400
//   VTT:  00:00.123 --> 00:02.500   |   01:02:03.456 --> 01:02:05.000
//   Also optional VTT cue settings after the arrow (align:start position:50%)
const TIMESTAMP_RE =
  /^\s*\d{1,2}:\d{2}(:\d{2})?[.,]\d{2,3}\s*-->\s*\d{1,2}:\d{2}(:\d{2})?[.,]\d{2,3}.*$/;

// A bare index number on its own line (1, 2, 42, 1000 ...).
const INDEX_RE = /^\s*\d+\s*$/;

// VTT cue identifier line (e.g. "cue-1" or any text that is NOT a
// number and NOT a timestamp and immediately precedes a timestamp).
// We don't strip arbitrary text, so we only treat a line as a cue-id
// when the *next* non-empty line is a timestamp.

// Inline timestamp tags used by some VTT files: <00:00:01.000>
const INLINE_TS_RE = /<\/?\d{1,2}:\d{2}(:\d{2})?[.,]\d{2,3}>/g;

// HTML-like styling tags: <i> <b> <u> <font ...> <c.classname> <00:00:01.000>
const HTML_TAG_RE = /<\/?[^>]+>/g;

// WebVTT block headers / metadata keywords
const VTT_HEADER_KEYWORDS = ['WEBVTT', 'STYLE', 'NOTE', 'REGION'];

function isVttHeaderLine(line) {
  const trimmed = line.trim();
  // "WEBVTT", "WEBVTT - Some title", "STYLE", "NOTE ...", "REGION ..."
  return VTT_HEADER_KEYWORDS.some(kw => trimmed === kw || trimmed.startsWith(kw + ' ') || trimmed.startsWith(kw + '\t'));
}

/**
 * Strip inline styling tags from a text line.
 */
function cleanInlineTags(text) {
  return text
    .replace(INLINE_TS_RE, '')   // <00:00:01.000> inline timestamps
    .replace(HTML_TAG_RE, '')    // <i>, <b>, <font color="...">, <c.foo>
    .replace(/\{[^}]*\}/g, '')   // legacy {an8} style ASS-ish tags (rare)
    .trim();
}

/**
 * Read a single cue's timecode in seconds, used to detect topic gaps.
 * Returns -1 if it cannot be parsed.
 */
function parseTimecodeToSeconds(tc) {
  // Normalize: "00:01:15,120" -> "00:01:15.120"
  const normalized = tc.trim().replace(',', '.');
  const m = normalized.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.](\d{1,3})$/);
  if (!m) return -1;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/**
 * Extract the start timecode from a timestamp line.
 */
function extractStartTime(line) {
  const match = line.match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{2,3})\s*-->/);
  return match ? parseTimecodeToSeconds(match[1]) : -1;
}

/**
 * Main entry: parse raw subtitle text into clean paragraphs.
 *
 * @param {string} raw        - The raw file contents (.srt or .vtt)
 * @param {object} [options]
 * @param {number} [options.gapThresholdSeconds=2.5]
 *        If the time gap between two consecutive cues exceeds this,
 *        a paragraph break is inserted (signals a topic/speaker change).
 * @returns {{ text: string, stats: { words:number, cues:number, durationSec:number } }}
 */
export function parseSubtitle(raw, options = {}) {
  const gapThreshold = options.gapThresholdSeconds ?? 2.5;

  if (!raw || !raw.trim()) {
    return { text: '', stats: { words: 0, cues: 0, durationSec: 0 } };
  }

  // Normalize newlines (handle CRLF + CR), strip BOM.
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = content.split('\n');

  // Collect cue text blocks. We walk the file line by line; whenever we
  // encounter a timestamp line we (re)start accumulating a cue.
  const cues = [];          // { startTime, lines: [string] }
  let current = null;       // the cue currently being filled
  let skipBlock = false;    // true while skipping a NOTE/STYLE/REGION block

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Skip empty lines (they separate cues, handled implicitly)
    if (line === '') {
      if (current) {
        // End of current cue's text gathering — keep it, a timestamp will close it.
      }
      skipBlock = false; // an empty line also ends a NOTE/STYLE block
      continue;
    }

    // ─── VTT headers / metadata blocks ───
    if (isVttHeaderLine(line)) {
      skipBlock = true;
      // Start/continue a metadata block. We ignore all lines until a blank line.
      continue;
    }
    if (skipBlock) {
      // We're inside a NOTE/STYLE/REGION block — discard.
      continue;
    }

    // ─── Timestamp line: start a new cue ───
    if (TIMESTAMP_RE.test(line)) {
      const startTime = extractStartTime(line);
      current = { startTime, lines: [] };
      cues.push(current);
      continue;
    }

    // ─── Index number line (SRT only) ───
    if (INDEX_RE.test(line)) {
      // Bare number on its own line. In SRT it's the cue index;
      // in VTT it could be a cue identifier. Either way, ignore it.
      // We do NOT treat it as text.
      continue;
    }

    // ─── VTT cue identifier (e.g. "cue-1") ───
    // A line that is immediately followed by a timestamp line is a cue id,
    // not subtitle text. Detect this BEFORE any other text handling,
    // regardless of whether a current cue is open.
    const nextNonEmpty = findNextNonEmpty(lines, i + 1);
    if (nextNonEmpty !== -1 && TIMESTAMP_RE.test(lines[nextNonEmpty].trim())) {
      // This line precedes a timestamp → it's a cue identifier. Skip it.
      continue;
    }

    // ─── Normal text line belonging to current cue ───
    if (current) {
      const cleaned = cleanInlineTags(line);
      if (cleaned) current.lines.push(cleaned);
    }
  }

  // ─── Merge cues into paragraphs ───
  const paragraphs = [];
  let para = [];

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const text = cue.lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // Detect a topic/speaker gap: big jump in start time from previous cue's end.
    if (i > 0 && para.length > 0) {
      const prev = cues[i - 1];
      if (cue.startTime >= 0 && prev.startTime >= 0) {
        const gap = cue.startTime - prev.startTime;
        // A rough gap heuristic: if the new cue starts much later than the
        // previous cue's start, treat it as a paragraph break. We use
        // gapThreshold as the cutoff for "noticeably later".
        if (gap > gapThreshold) {
          paragraphs.push(para.join(' '));
          para = [];
        }
      }
    }

    para.push(text);
  }
  if (para.length > 0) paragraphs.push(para.join(' '));

  const text = paragraphs.join('\n\n');

  // ─── Stats ───
  const words = (text.match(/\S+/g) || []).length;
  const durationSec = cues.length
    ? cues[cues.length - 1].startTime
    : 0;

  return {
    text,
    stats: {
      words,
      cues: cues.length,
      durationSec,
    },
  };
}

function findNextNonEmpty(lines, fromIdx) {
  for (let i = fromIdx; i < lines.length; i++) {
    if (lines[i].trim() !== '') return i;
  }
  return -1;
}

/**
 * Convenience: detect subtitle format from filename.
 */
export function detectFormat(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'srt') return 'SRT';
  if (ext === 'vtt') return 'VTT';
  return ext.toUpperCase();
}

/**
 * Format a duration in seconds as mm:ss or hh:mm:ss.
 */
export function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) return '--:--';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
