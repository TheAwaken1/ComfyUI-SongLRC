// LRC parsing, kept free of ComfyUI imports so it can be tested on its own.

const TIMESTAMP = /^\[(\d{1,3}):(\d{1,2}(?:[.,]\d{1,3})?)\](.*)$/;
const META = /^\[([a-zA-Z]+):(.*)\]$/;
// Enhanced LRC: a <mm:ss.xx> tag in front of every sung word.
const WORD_TAG = /<(\d{1,3}):(\d{1,2}(?:[.,]\d{1,3})?)>/g;

function seconds(minutes, rest) {
  return parseInt(minutes, 10) * 60 + parseFloat(rest.replace(",", "."));
}

// Split a line body into timed words. A closing tag with no word after it
// marks where the last word ends. Returns null for a plain, untagged line.
function parseWords(body, lineTime) {
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(body)) return null;
  const words = [];
  let end = null;
  let time = lineTime;
  let cursor = 0;
  WORD_TAG.lastIndex = 0;
  const push = (text) => {
    if (text.trim()) words.push({ time, text: text.trim() });
  };
  for (let match; (match = WORD_TAG.exec(body)); ) {
    push(body.slice(cursor, match.index));
    time = seconds(match[1], match[2]);
    cursor = WORD_TAG.lastIndex;
  }
  const tail = body.slice(cursor);
  if (tail.trim()) push(tail);
  else end = time;
  return words.length ? { words, end } : null;
}

export function parseLrc(text) {
  const cues = [];
  let title = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const timed = TIMESTAMP.exec(line);
    if (timed) {
      const time = seconds(timed[1], timed[2]);
      const tagged = parseWords(timed[3], time);
      cues.push(tagged
        ? {
          time,
          text: tagged.words.map((word) => word.text).join(" "),
          words: tagged.words,
          end: tagged.end,
        }
        : { time, text: timed[3].trim(), words: null, end: null });
      continue;
    }
    const meta = META.exec(line);
    if (meta && meta[1].toLowerCase() === "ti") title = meta[2].trim();
  }
  cues.sort((a, b) => a.time - b.time);
  return { cues, title };
}

// m:ss for the transport clock; an unknown length reads as 0:00.
export function formatClock(seconds) {
  const whole = isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes + ":" + (rest < 10 ? "0" : "") + rest;
}

// Index of the line that should be lit at a given moment, or -1 before the first.
export function activeCue(cues, seconds) {
  let index = -1;
  for (let i = 0; i < cues.length; i += 1) {
    if (cues[i].time <= seconds + 0.02) index = i;
    else break;
  }
  return index;
}

// How far through each word the singer is, 0..1, for the karaoke fill.
// A word runs until the next one starts, or the line's closing tag, but never
// more than a second and a half, so a held gap does not look like a slow word.
export function wordProgress(cue, nextTime, seconds) {
  const words = cue.words || [];
  return words.map((word, i) => {
    const following = i + 1 < words.length ? words[i + 1].time
      : cue.end != null ? cue.end : nextTime;
    const end = Math.min(following, word.time + 1.5);
    if (seconds <= word.time) return 0;
    if (!(end > word.time) || seconds >= end) return 1;
    return (seconds - word.time) / (end - word.time);
  });
}
