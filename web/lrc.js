// LRC parsing, kept free of ComfyUI imports so it can be tested on its own.

const TIMESTAMP = /^\[(\d{1,3}):(\d{1,2}(?:[.,]\d{1,3})?)\](.*)$/;
const META = /^\[([a-zA-Z]+):(.*)\]$/;

export function parseLrc(text) {
  const cues = [];
  let title = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const timed = TIMESTAMP.exec(line);
    if (timed) {
      const seconds = parseInt(timed[1], 10) * 60 + parseFloat(timed[2].replace(",", "."));
      cues.push({ time: seconds, text: timed[3].trim() });
      continue;
    }
    const meta = META.exec(line);
    if (meta && meta[1].toLowerCase() === "ti") title = meta[2].trim();
  }
  cues.sort((a, b) => a.time - b.time);
  return { cues, title };
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
