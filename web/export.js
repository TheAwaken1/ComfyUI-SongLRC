// Lyric video export: 720p frames of the chosen visualizer style, the title,
// the current line with its karaoke fill, the time and a progress bar.
//
// renderVideo (the normal path) works offline: it decodes the song, steps an
// OfflineAudioContext frame by frame to read the spectrum, draws each frame
// and compresses it with WebCodecs, all faster than real time and without
// touching the player. ComfyUI then adds the audio and writes the MP4.
//
// startExport is the fallback for browsers without WebCodecs: it plays the
// song once from the top and records it in real time with MediaRecorder.

import { activeCue, formatClock, wordProgress } from "./lrc.js";
import { createVisualizer, makeAnalyser } from "./visualizer.js";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const SUNG = "#ffb27a";
const UNSUNG = "rgba(255,226,205,.5)";
const LIT = "#ffe2cd";
const FONT = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

// MP4 where the browser can record it (recent Chrome and Edge), WebM otherwise.
const FORMATS = [
  ["video/mp4;codecs=avc1.4d002a,mp4a.40.2", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9,opus", "webm"],
  ["video/webm;codecs=vp8,opus", "webm"],
  ["video/webm", "webm"],
];

function pickFormat() {
  if (!window.MediaRecorder) return null;
  for (const [type, extension] of FORMATS) {
    if (MediaRecorder.isTypeSupported(type)) return { type, extension };
  }
  return null;
}

export function canExport() {
  return Boolean(pickFormat() && HTMLCanvasElement.prototype.captureStream);
}

export function fileName(title, extension) {
  const safe = String(title || "").replace(/[\\/:*?"<>|]+/g, "").trim() || "SongLRC";
  return safe + " (lyric video)." + extension;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Largest size up to `size` at which the text fits the frame.
function fitFont(ctx, text, size, weight) {
  for (; size > 18; size -= 2) {
    ctx.font = weight + " " + size + "px " + FONT;
    if (ctx.measureText(text).width <= WIDTH - 120) break;
  }
  return size;
}

function drawLine(ctx, cue, next, seconds) {
  const text = cue.text || "· · ·";
  const size = fitFont(ctx, text, 46, "700");
  const width = ctx.measureText(text).width;
  const left = (WIDTH - width) / 2;
  // Each new line rises in over a quarter of a second.
  const age = Math.min(1, Math.max(0, (seconds - cue.time) / 0.25));
  const y = 622 + (1 - age) * 12;

  ctx.save();
  ctx.globalAlpha = age;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(255,170,120,.5)";
  ctx.shadowBlur = size * 0.5;
  if (!cue.words) {
    ctx.fillStyle = cue.text ? LIT : UNSUNG;
    ctx.fillText(text, left, y);
    ctx.restore();
    return;
  }
  ctx.fillStyle = UNSUNG;
  ctx.fillText(text, left, y);

  // Width of what has been sung: every word before the current one, plus the
  // sung part of the current one.
  const progress = wordProgress(cue, next ? next.time : Infinity, seconds);
  let sung = 0;
  progress.forEach((part, i) => {
    if (part <= 0) return;
    const before = cue.words.slice(0, i).map((word) => word.text).join(" ");
    sung = ctx.measureText(before ? before + " " : "").width +
      part * ctx.measureText(cue.words[i].text).width;
  });
  if (sung > 0) {
    ctx.beginPath();
    ctx.rect(left - 4, y - size, sung + 4, size * 2);
    ctx.clip();
    ctx.fillStyle = SUNG;
    ctx.fillText(text, left, y);
  }
  ctx.restore();
}

function drawFrame(ctx, ring, layout, cues, title, seconds, duration) {
  ctx.fillStyle = "#07050b";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.43, 0,
    WIDTH / 2, HEIGHT * 0.43, WIDTH * 0.7);
  glow.addColorStop(0, "rgba(150,47,58,.38)");
  glow.addColorStop(0.4, "rgba(138,61,20,.18)");
  glow.addColorStop(1, "rgba(7,5,11,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (layout === "full") {
    // Full-frame styles run edge to edge, with a dark band so the words read.
    ctx.drawImage(ring, 0, 0, WIDTH, HEIGHT);
    const band = ctx.createLinearGradient(0, HEIGHT - 190, 0, HEIGHT);
    band.addColorStop(0, "rgba(7,5,11,0)");
    band.addColorStop(0.45, "rgba(7,5,11,.72)");
    band.addColorStop(1, "rgba(7,5,11,.9)");
    ctx.fillStyle = band;
    ctx.fillRect(0, HEIGHT - 190, WIDTH, 190);
  } else {
    // Inset styles sit above centre, leaving the bottom for the words.
    const scale = 0.82;
    ctx.drawImage(ring, (WIDTH - WIDTH * scale) / 2, 14, WIDTH * scale, HEIGHT * scale);
  }

  ctx.save();
  ctx.font = "600 20px " + FONT;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "4px";
  ctx.fillStyle = "rgba(255,226,205,.6)";
  ctx.textBaseline = "top";
  ctx.fillText(String(title || "").toUpperCase(), 40, 36);
  ctx.restore();

  const index = activeCue(cues, seconds);
  if (index >= 0) drawLine(ctx, cues[index], cues[index + 1], seconds);
  let upcoming = index + 1;
  while (upcoming < cues.length && !cues[upcoming].text) upcoming += 1;
  if (upcoming < cues.length) {
    ctx.save();
    fitFont(ctx, cues[upcoming].text, 24, "400");
    ctx.fillStyle = "rgba(232,232,234,.42)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cues[upcoming].text, WIDTH / 2, 676);
    ctx.restore();
  }

  // Progress bar with a playhead, and the time above its right end.
  const done = duration > 0 ? Math.min(1, seconds / duration) : 0;
  const barY = HEIGHT - 14;
  ctx.fillStyle = "rgba(255,255,255,.14)";
  ctx.fillRect(0, barY, WIDTH, 6);
  const bar = ctx.createLinearGradient(0, 0, WIDTH, 0);
  bar.addColorStop(0, "#8a3d14");
  bar.addColorStop(1, "#ffb27a");
  ctx.fillStyle = bar;
  ctx.fillRect(0, barY, WIDTH * done, 6);
  ctx.save();
  ctx.shadowColor = "rgba(255,170,120,.8)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#ffe2cd";
  ctx.beginPath();
  ctx.arc(Math.min(WIDTH - 7, Math.max(7, WIDTH * done)), barY + 3, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.font = "600 18px " + FONT;
  if ("fontVariantNumeric" in ctx) ctx.fontVariantNumeric = "tabular-nums";
  ctx.fillStyle = "rgba(255,226,205,.8)";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(formatClock(seconds) + " / " + formatClock(duration), WIDTH - 24, barY - 8);
  ctx.restore();
}

// Record from the start of the song. `source` is the player's
// MediaElementAudioSourceNode; the recording taps it at full level, so the
// player's volume and mute do not reach the file. onDone receives
// { blob, extension, seconds, reason }.
export function startExport({ context, source, player, cues, title, style, onProgress, onDone }) {
  const format = pickFormat();
  if (!format) throw new Error("This browser cannot record video");

  const frame = document.createElement("canvas");
  frame.width = WIDTH;
  frame.height = HEIGHT;
  const ctx = frame.getContext("2d");
  const ringCanvas = document.createElement("canvas");
  ringCanvas.width = WIDTH;
  ringCanvas.height = HEIGHT;
  const ring = createVisualizer(ringCanvas, { scale: 2, style });
  const analyser = makeAnalyser(context);
  source.connect(analyser);
  ring.attach(analyser);
  const sound = context.createMediaStreamDestination();
  source.connect(sound);

  const stream = new MediaStream([
    ...frame.captureStream(FPS).getVideoTracks(),
    ...sound.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(stream, {
    mimeType: format.type,
    videoBitsPerSecond: 8000000,
    audioBitsPerSecond: 192000,
  });
  const chunks = [];
  let loop = 0;
  let finished = false;
  let reason = "";
  let recorded = 0;

  const onPause = () => {
    if (recorder.state === "recording") recorder.pause();
  };
  const onPlay = () => {
    if (recorder.state === "paused") recorder.resume();
  };
  const stop = (why) => {
    if (finished) return;
    finished = true;
    reason = typeof why === "string" ? why : "ended";
    recorded = player.currentTime;
    player.pause();
    if (recorder.state !== "inactive") recorder.stop();
  };
  const onEnded = () => stop("ended");

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    cancelAnimationFrame(loop);
    player.removeEventListener("pause", onPause);
    player.removeEventListener("play", onPlay);
    player.removeEventListener("ended", onEnded);
    for (const track of stream.getTracks()) track.stop();
    try {
      source.disconnect(analyser);
      source.disconnect(sound);
    } catch (error) {
      // Already gone with the audio context.
    }
    const blob = new Blob(chunks, { type: format.type.split(";")[0] });
    console.log("[SongLRC] export finished (" + reason + ") at " + recorded.toFixed(1) +
      " s, " + (blob.size / 1048576).toFixed(1) + " MB");
    if (onDone) onDone({ blob, extension: format.extension, seconds: recorded, reason });
  };

  const draw = (now) => {
    ring.paint(now);
    drawFrame(ctx, ringCanvas, ring.layout, cues, title, player.currentTime, player.duration);
    if (onProgress) onProgress(player.currentTime, player.duration);
    loop = requestAnimationFrame(draw);
  };

  player.addEventListener("pause", onPause);
  player.addEventListener("play", onPlay);
  player.addEventListener("ended", onEnded);
  player.currentTime = 0;
  drawFrame(ctx, ringCanvas, ring.layout, cues, title, 0, player.duration);
  recorder.start(1000);
  loop = requestAnimationFrame(draw);
  // An interrupted play() (a seek racing it) is harmless; anything else ends it.
  player.play().catch((error) => {
    if (!error || error.name !== "AbortError") stop("play failed: " + (error && error.message));
  });
  return { stop: () => stop("stopped") };
}

// ------------------------------------------------------------ offline render

// H.264 first (ComfyUI only has to add the audio), then VP8 / VP9, which
// every Chromium can encode in software.
const CODECS = [
  { kind: "h264", config: { codec: "avc1.42001f", avc: { format: "annexb" } } },
  { kind: "h264", config: { codec: "avc1.4d0028", avc: { format: "annexb" } } },
  { kind: "ivf", fourcc: "VP80", config: { codec: "vp8" } },
  { kind: "ivf", fourcc: "VP90", config: { codec: "vp09.00.10.08" } },
];

export function canRender() {
  return typeof VideoEncoder === "function" && typeof VideoFrame === "function" &&
    typeof OfflineAudioContext === "function";
}

async function pickCodec() {
  for (const option of CODECS) {
    const config = { ...option.config, width: WIDTH, height: HEIGHT, bitrate: 8000000, framerate: FPS };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return { ...option, config };
    } catch (error) {
      // Not this one; try the next.
    }
  }
  return null;
}

// IVF is the simplest container for VP8 / VP9 frames.
function ivfHeader(fourcc, frames) {
  const view = new DataView(new ArrayBuffer(32));
  [..."DKIF"].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint16(6, 32, true);
  [...fourcc].forEach((c, i) => view.setUint8(8 + i, c.charCodeAt(0)));
  view.setUint16(12, WIDTH, true);
  view.setUint16(14, HEIGHT, true);
  view.setUint32(16, FPS, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, frames, true);
  return view.buffer;
}

function ivfFrame(size, index) {
  const view = new DataView(new ArrayBuffer(12));
  view.setUint32(0, size, true);
  view.setUint32(4, index, true);
  return view.buffer;
}

function drained(encoder) {
  return new Promise((resolve) => {
    if ("ondequeue" in encoder) encoder.addEventListener("dequeue", resolve, { once: true });
    else setTimeout(resolve, 1);
  });
}

// Render the whole song. Resolves to { blob, kind, fps, seconds } where kind is
// "h264" (Annex B stream) or "ivf" (VP8 / VP9). onProgress gets 0..1.
export async function renderVideo({ audioUrl, cues, title, style, onProgress, signal }) {
  const codec = await pickCodec();
  if (!codec) throw new Error("This browser cannot encode video");

  const bytes = await (await fetch(audioUrl)).arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
  const duration = buffer.duration;
  const frames = Math.max(1, Math.floor(duration * FPS));

  const offline = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const analyser = makeAnalyser(offline);
  source.connect(analyser);
  analyser.connect(offline.destination);

  const frame = document.createElement("canvas");
  frame.width = WIDTH;
  frame.height = HEIGHT;
  const ctx = frame.getContext("2d");
  const ringCanvas = document.createElement("canvas");
  ringCanvas.width = WIDTH;
  ringCanvas.height = HEIGHT;
  const ring = createVisualizer(ringCanvas, { scale: 2, style });
  ring.attach(analyser);

  const chunks = [];
  let failure = null;
  const encoder = new VideoEncoder({
    output(chunk) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
    },
    error(error) {
      failure = error;
    },
  });
  encoder.configure(codec.config);

  // Suspend the audio at each frame's time, read the analyser, draw, encode,
  // then let the audio run on to the next frame. Suspend times are rounded to
  // 128-sample blocks, so frame 0 waits for the first block.
  const block = 128 / buffer.sampleRate;
  let index = 0;
  const next = () => offline.suspend(Math.max(block, index / FPS)).then(async () => {
    try {
      if (signal && signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (failure) throw failure;
      const seconds = index / FPS;
      ring.paint(seconds * 1000);
      drawFrame(ctx, ringCanvas, ring.layout, cues, title, seconds, duration);
      const image = new VideoFrame(frame, {
        timestamp: Math.round(seconds * 1e6),
        duration: Math.round(1e6 / FPS),
      });
      encoder.encode(image, { keyFrame: index % (FPS * 2) === 0 });
      image.close();
      while (encoder.encodeQueueSize > 6) await drained(encoder);
      if (onProgress) onProgress((index + 1) / frames);
      index += 1;
      if (index < frames) next();
    } catch (error) {
      failure = failure || error;
    }
    offline.resume();
  });
  next();
  source.start(0);
  await offline.startRendering();
  if (failure) {
    encoder.close();
    throw failure;
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  const parts = [];
  if (codec.kind === "ivf") {
    parts.push(ivfHeader(codec.fourcc, chunks.length));
    chunks.forEach((data, i) => parts.push(ivfFrame(data.byteLength, i), data));
  } else {
    parts.push(...chunks);
  }
  return {
    blob: new Blob(parts, { type: "application/octet-stream" }),
    kind: codec.kind,
    fps: FPS,
    seconds: duration,
  };
}
