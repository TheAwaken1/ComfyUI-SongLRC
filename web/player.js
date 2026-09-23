import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { parseLrc, activeCue, formatClock, wordProgress } from "./lrc.js";
import { createVisualizer, makeAnalyser, STYLES } from "./visualizer.js";
import {
  canExport, canRender, download, fileName, renderVideo, startExport,
} from "./export.js";

// Two views over one song. Lyrics is a wheel: the current line sits centred and
// large, neighbours recede above and below on a tilted arc, and the far ones fade
// into the frame. Visualizer swaps the wheel for one of several styles (Ring,
// Bars, Tunnel, Warp) and keeps the current line as a caption, so the timing
// can still be judged by ear.
// When the LRC carries word tags, the current line fills word by word.
// Export renders the song as a lyric video offline, faster than real time and
// without touching playback; ComfyUI adds the audio, saves the MP4 under
// output/video/SongLRC and it downloads.

const LINE_HEIGHT = 30;
const MASK = "linear-gradient(to bottom,transparent 0%,#000 22%,#000 78%,transparent 100%)";
const VIEWS = [
  ["lyrics", "Lyrics"],
  ["visualizer", "Visualizer"],
];
const SUNG = "#ffb27a";
const UNSUNG = "rgba(255,226,205,.5)";

const SPEAKER = '<path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/>';
const WAVE_NEAR = '<path d="M16 9a4 4 0 0 1 0 6"/>';
const WAVE_FAR = '<path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>';
const CROSS = '<path d="M16 9.5l5 5M21 9.5l-5 5"/>';

function speakerIcon(level) {
  const extra = level <= 0 ? CROSS : level < 0.5 ? WAVE_NEAR : WAVE_NEAR + WAVE_FAR;
  return (
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round">' + SPEAKER + extra + "</svg>"
  );
}

function pill(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.cssText =
    "border:0;border-radius:999px;padding:3px 10px;cursor:pointer;font:inherit;" +
    "font-size:11px;letter-spacing:.04em;color:rgba(232,232,234,.75);" +
    "background:rgba(255,255,255,.08);transition:background .2s,color .2s,opacity .2s;";
  button.addEventListener("click", onClick);
  return button;
}

function build(node) {
  const root = document.createElement("div");
  root.tabIndex = 0;
  root.style.cssText =
    "display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;outline:none;" +
    "padding:8px;box-sizing:border-box;font-family:inherit;";

  const top = document.createElement("div");
  top.style.cssText = "display:flex;align-items:center;gap:8px;flex:0 0 auto;";

  const heading = document.createElement("div");
  heading.style.cssText =
    "flex:1 1 auto;min-width:0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;" +
    "opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  heading.textContent = "Run the graph to load a song";

  const exportButton = pill("Export", "Render the Visualizer and lyrics to a video file",
    () => toggleExport(node));

  const tabs = document.createElement("div");
  tabs.style.cssText =
    "display:flex;flex:0 0 auto;padding:2px;border-radius:999px;" +
    "background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09);";
  const tabButtons = {};
  for (const [view, label] of VIEWS) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = label;
    tab.style.cssText =
      "border:0;border-radius:999px;padding:3px 10px;cursor:pointer;font:inherit;" +
      "font-size:11px;letter-spacing:.04em;transition:background .2s,color .2s;";
    tab.addEventListener("click", () => setView(node, view));
    tabButtons[view] = tab;
    tabs.append(tab);
  }
  const styleButton = pill("Ring", "Change the visualizer style", () => cycleStyle(node));
  top.append(heading, styleButton, exportButton, tabs);

  const frame = document.createElement("div");
  frame.style.cssText =
    "position:relative;flex:1 1 auto;min-height:120px;overflow:hidden;border-radius:12px;" +
    "background:radial-gradient(130% 90% at 50% 50%,rgba(150,47,58,.34) 0%," +
    "rgba(138,61,20,.20) 38%,rgba(6,4,10,.86) 100%);" +
    "box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),inset 0 14px 34px rgba(0,0,0,.55)," +
    "inset 0 -14px 34px rgba(0,0,0,.55);";

  const layer =
    "position:absolute;inset:0;transition:opacity .35s ease;";

  const lyrics = document.createElement("div");
  lyrics.style.cssText = layer;

  const glow = document.createElement("div");
  glow.style.cssText =
    "position:absolute;left:8%;right:8%;top:50%;height:" + LINE_HEIGHT + "px;" +
    "transform:translateY(-50%);pointer-events:none;border-radius:8px;" +
    "background:linear-gradient(90deg,transparent,rgba(255,196,150,.10),transparent);";

  const reel = document.createElement("div");
  reel.style.cssText =
    "position:absolute;left:0;right:0;top:0;transform-style:preserve-3d;" +
    "transition:transform .34s cubic-bezier(.22,.9,.24,1);will-change:transform;";
  lyrics.append(glow, reel);

  const visual = document.createElement("div");
  visual.style.cssText = layer + "pointer-events:none;";

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";

  const caption = document.createElement("div");
  caption.style.cssText =
    "position:absolute;left:10px;right:10px;bottom:10px;text-align:center;font-size:14px;" +
    "font-weight:700;color:#ffe2cd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
    "text-shadow:0 0 16px rgba(255,170,120,.55),0 1px 3px rgba(0,0,0,.9);";
  // The style's name, shown large for a moment when it changes.
  const styleName = document.createElement("div");
  styleName.style.cssText =
    "position:absolute;left:0;right:0;top:12px;text-align:center;font-size:12px;" +
    "font-weight:700;letter-spacing:.4em;text-transform:uppercase;color:#ffe2cd;opacity:0;" +
    "text-shadow:0 0 14px rgba(255,170,120,.7);";
  visual.append(canvas, caption, styleName);

  frame.append(lyrics, visual);
  root.append(top, frame);
  node._songLrc = {
    root, heading, frame, reel, lyrics, visual, caption, tabButtons, exportButton,
    styleButton, styleName, style: "ring",
    visualizer: createVisualizer(canvas),
    cues: [], title: "", active: -2, view: "lyrics", volume: 1, muted: false,
    graph: undefined, captionSpans: null, loop: 0, recording: null,
  };

  root.addEventListener("pointerdown", () => root.focus({ preventScroll: true }));
  root.addEventListener("keydown", (event) => onKey(node, event));
  return root;
}

function setStyle(node, name, announce) {
  const state = node._songLrc;
  const entry = STYLES.find(([key]) => key === name) || STYLES[0];
  state.style = entry[0];
  node.properties.songLrcStyle = state.style;
  state.visualizer.setStyle(state.style);
  state.styleButton.textContent = entry[1];
  if (announce && state.styleName.animate) {
    state.styleName.textContent = entry[1];
    state.styleName.animate(
      [{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none", offset: 0.2 },
        { opacity: 1, offset: 0.7 }, { opacity: 0 }],
      { duration: 1200, easing: "ease-out" }
    );
  }
}

function cycleStyle(node) {
  const state = node._songLrc;
  const index = STYLES.findIndex(([key]) => key === state.style);
  setStyle(node, STYLES[(index + 1) % STYLES.length][0], true);
}

// Show a short message on the Export button, then put its label back.
function flash(state, text) {
  const button = state.exportButton;
  button.textContent = text;
  clearTimeout(state.flashTimer);
  state.flashTimer = setTimeout(() => {
    if (!state.recording && !state.rendering && !state.saving) button.textContent = "Export";
  }, 3000);
}

function busy(state, on, title) {
  const button = state.exportButton;
  clearTimeout(state.flashTimer);
  button.style.background = on ? "rgba(190,40,48,.85)" : "rgba(255,255,255,.08)";
  button.style.color = on ? "#fff" : "rgba(232,232,234,.75)";
  button.title = title || "Render the Visualizer and lyrics to a video file";
}

// Upload pieces small enough for ComfyUI's default request size limit.
const PIECE = 8 * 1024 * 1024;

async function postOk(path, body, json) {
  const response = await api.fetchApi(path, {
    method: "POST",
    body: json ? JSON.stringify(body) : body,
    headers: json ? { "Content-Type": "application/json" } : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}

async function upload(state, blob) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (let index = 0, offset = 0; offset < blob.size; index += 1, offset += PIECE) {
    state.exportButton.textContent = "Uploading " + Math.round((offset / blob.size) * 100) + "%";
    await postOk("/songlrc/video/part?id=" + id + "&index=" + index,
      blob.slice(offset, offset + PIECE));
  }
  return id;
}

function downloadOutput(state, file) {
  const link = document.createElement("a");
  link.href = api.apiURL("/view?" + new URLSearchParams(file).toString());
  link.download = file.filename;
  document.body.append(link);
  link.click();
  link.remove();
  state.exportButton.title = "Saved to output/" + file.subfolder + "/" + file.filename;
}

// The normal path: render every frame offline, then ComfyUI adds the audio.
async function renderExport(state) {
  const controller = new AbortController();
  state.rendering = controller;
  busy(state, true, "Rendering the video. Playback is not affected. Click to cancel.");
  try {
    const result = await renderVideo({
      audioUrl: state.player.src,
      cues: state.cues,
      title: state.title,
      style: state.style,
      signal: controller.signal,
      onProgress(done) {
        state.exportButton.textContent = "Rendering " + Math.floor(done * 100) + "% \u2715";
      },
    });
    state.rendering = null;
    state.saving = true;
    busy(state, true, "Saving the video");
    const id = await upload(state, result.blob);
    state.exportButton.textContent = "Encoding\u2026";
    const file = await postOk("/songlrc/video/encode", {
      id, title: state.title, kind: result.kind, fps: result.fps, audio: state.audioFile,
    }, true);
    downloadOutput(state, file);
    busy(state, false, state.exportButton.title);
    flash(state, "Saved " + formatClock(result.seconds) + " \u2713");
  } catch (error) {
    busy(state, false);
    if (error && error.name === "AbortError") {
      flash(state, "Cancelled");
    } else {
      console.warn("[SongLRC] export failed:", error);
      flash(state, "Export failed");
    }
  } finally {
    state.rendering = null;
    state.saving = false;
  }
}

// Fallback for browsers without WebCodecs: record in real time from the top.
async function saveRecording(state, { blob, extension }) {
  try {
    const id = await upload(state, blob);
    state.exportButton.textContent = "Finishing\u2026";
    downloadOutput(state, await postOk("/songlrc/video/finish",
      { id, title: state.title, extension }, true));
    return true;
  } catch (error) {
    console.warn("[SongLRC] could not save the video through ComfyUI, downloading it as recorded:",
      error);
    download(blob, fileName(state.title, extension));
    return false;
  }
}

function recordExport(state) {
  ensureGraph(state);
  if (!state.graph) {
    flash(state, "No audio");
    return;
  }
  busy(state, true, "Recording in real time from the top. Click to stop early.");
  try {
    state.recording = startExport({
      context: state.graph.context,
      source: state.graph.source,
      player: state.player,
      cues: state.cues,
      title: state.title,
      style: state.style,
      onProgress(seconds, duration) {
        state.exportButton.textContent = "\u25a0 " + formatClock(seconds) + " / " + formatClock(duration);
      },
      async onDone(result) {
        state.recording = null;
        if (!result.blob.size) {
          busy(state, false);
          flash(state, "Nothing recorded");
          return;
        }
        state.saving = true;
        const saved = await saveRecording(state, result);
        state.saving = false;
        busy(state, false, state.exportButton.title);
        flash(state, (saved ? "Saved " : "Downloaded ") + formatClock(result.seconds) + " \u2713");
      },
    });
  } catch (error) {
    console.warn("[SongLRC] export failed:", error);
    state.recording = null;
    busy(state, false);
    flash(state, "Export failed");
  }
}

function toggleExport(node) {
  const state = node._songLrc;
  if (state.saving) return;
  if (state.rendering) {
    state.rendering.abort();
    return;
  }
  if (state.recording) {
    stopExport(node);
    return;
  }
  if (!state.cues.length || !state.player.src || !state.audioFile) {
    flash(state, "Run first");
    return;
  }
  if (canRender()) renderExport(state);
  else if (canExport()) recordExport(state);
  else flash(state, "Not supported");
}

function stopExport(node) {
  const state = node._songLrc;
  if (state.rendering) state.rendering.abort();
  if (state.recording) state.recording.stop();
}

function onKey(node, event) {
  const state = node._songLrc;
  if (!state || !state.player || event.key !== " ") return;
  if (state.player.paused) play(state);
  else state.player.pause();
  // Keep ComfyUI's own Space (pan the canvas) out of it.
  event.preventDefault();
  event.stopPropagation();
}

// ------------------------------------------------------------ audio + views

// Route the audio through Web Audio on the first user gesture, so the
// visualizer can read it. Volume moves to a gain node at that point, which
// keeps the visualizer lively even when the song is turned down.
function ensureGraph(state) {
  if (state.graph === undefined) {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      const context = new Context();
      const source = context.createMediaElementSource(state.player);
      const analyser = makeAnalyser(context);
      const gain = context.createGain();
      source.connect(analyser);
      source.connect(gain);
      gain.connect(context.destination);
      state.graph = { context, gain, source };
      state.visualizer.attach(analyser);
    } catch (error) {
      console.warn("[SongLRC] visualizer unavailable:", error);
      state.graph = null;
    }
    applyVolume(state);
  }
  if (state.graph && state.graph.context.state === "suspended") {
    state.graph.context.resume().catch(() => {});
  }
}

function play(state) {
  ensureGraph(state);
  state.player.play().catch(() => {});
}

function applyVolume(state) {
  const level = state.muted ? 0 : state.volume;
  if (state.graph) {
    state.graph.gain.gain.value = level;
    state.player.volume = 1;
  } else {
    state.player.volume = level;
  }
  if (state.volumeSlider) state.volumeSlider.set(level);
  if (state.muteButton) {
    state.muteButton.innerHTML = speakerIcon(level);
    state.muteButton.title = state.muted ? "Unmute" : "Mute";
  }
}

function setVolume(node, level) {
  const state = node._songLrc;
  state.volume = Math.min(1, Math.max(0, level));
  state.muted = state.volume === 0;
  node.properties.songLrcVolume = state.volume;
  applyVolume(state);
}

function setView(node, view) {
  const state = node._songLrc;
  state.view = view === "visualizer" ? "visualizer" : "lyrics";
  node.properties.songLrcView = state.view;
  const showVisual = state.view === "visualizer";

  state.lyrics.style.opacity = showVisual ? "0" : "1";
  state.lyrics.style.pointerEvents = showVisual ? "none" : "auto";
  state.visual.style.opacity = showVisual ? "1" : "0";
  state.styleButton.style.display = showVisual ? "" : "none";
  // The fade at the top and bottom suits the wheel but would clip the ring.
  state.frame.style.webkitMaskImage = showVisual ? "none" : MASK;
  state.frame.style.maskImage = showVisual ? "none" : MASK;

  for (const [name, tab] of Object.entries(state.tabButtons)) {
    const on = name === state.view;
    tab.style.background = on ? "rgba(150,47,58,.75)" : "transparent";
    tab.style.color = on ? "#ffe2cd" : "rgba(232,232,234,.6)";
  }

  if (showVisual) state.visualizer.start();
  else state.visualizer.stop();
  highlight(node, true);
}

function slider(onRatio) {
  const track = document.createElement("div");
  track.style.cssText =
    "position:relative;height:6px;border-radius:3px;cursor:pointer;" +
    "background:rgba(255,255,255,.12);overflow:hidden;touch-action:none;";
  const fill = document.createElement("div");
  fill.style.cssText =
    "position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:3px;" +
    "background:linear-gradient(90deg,#8a3d14,#ffb27a);";
  track.append(fill);

  function pick(event) {
    const box = track.getBoundingClientRect();
    if (!box.width) return;
    onRatio(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
  }
  track.addEventListener("pointerdown", (event) => {
    track.setPointerCapture(event.pointerId);
    pick(event);
    const move = (moved) => pick(moved);
    const stop = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", stop);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", stop);
  });

  return {
    track,
    set(ratio) {
      fill.style.width = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(2) + "%";
    },
  };
}

function transport(node, player) {
  const state = node._songLrc;
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:2px 2px 0;";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "▶";
  button.style.cssText =
    "width:30px;height:30px;flex:0 0 auto;border:0;border-radius:50%;cursor:pointer;" +
    "color:#ffe2cd;background:rgba(150,47,58,.55);font-size:12px;line-height:30px;" +
    "box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);transition:background .2s;";
  button.addEventListener("click", () => {
    if (player.paused) play(state);
    else player.pause();
  });

  const clock =
    "flex:0 0 auto;font-size:11px;opacity:.7;font-variant-numeric:tabular-nums;" +
    "color:#e8e8ea;min-width:30px;";
  const now = document.createElement("span");
  now.style.cssText = clock + "text-align:right;";
  const total = document.createElement("span");
  total.style.cssText = clock;
  now.textContent = total.textContent = formatClock(0);

  const seek = slider((ratio) => {
    if (isFinite(player.duration)) player.currentTime = ratio * player.duration;
  });
  seek.track.style.flex = "1 1 auto";

  const mute = document.createElement("button");
  mute.type = "button";
  mute.style.cssText =
    "flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:24px;" +
    "height:24px;padding:0;border:0;border-radius:6px;cursor:pointer;" +
    "color:#ffe2cd;background:transparent;opacity:.85;";
  mute.addEventListener("click", () => {
    if (state.muted || state.volume === 0) {
      state.muted = false;
      if (state.volume === 0) state.volume = 0.8;
    } else {
      state.muted = true;
    }
    applyVolume(state);
  });

  const volume = slider((ratio) => setVolume(node, ratio));
  volume.track.style.cssText += "flex:0 0 64px;";
  volume.track.title = "Volume";
  volume.track.addEventListener(
    "wheel",
    (event) => {
      // Scrolling over the slider nudges the volume instead of zooming the canvas.
      event.preventDefault();
      event.stopPropagation();
      const current = state.muted ? 0 : state.volume;
      setVolume(node, current + (event.deltaY < 0 ? 0.05 : -0.05));
    },
    { passive: false }
  );

  state.volumeSlider = volume;
  state.muteButton = mute;

  function tick() {
    now.textContent = formatClock(player.currentTime);
    total.textContent = formatClock(player.duration);
    seek.set(isFinite(player.duration) && player.duration
      ? player.currentTime / player.duration : 0);
  }
  player.addEventListener("timeupdate", tick);
  player.addEventListener("durationchange", tick);
  player.addEventListener("emptied", tick);
  player.addEventListener("play", () => {
    button.textContent = "⏸";
  });
  player.addEventListener("pause", () => {
    button.textContent = "▶";
  });
  player.addEventListener("ended", () => {
    button.textContent = "▶";
  });

  bar.append(button, now, seek.track, total, mute, volume.track);
  return bar;
}

// ------------------------------------------------------------ lyrics + fill

function styleRow(row, distance, isActive) {
  const away = Math.abs(distance);
  const scale = isActive ? 1.24 : Math.max(0.72, 1 - away * 0.09);
  const opacity = isActive ? 1 : Math.max(0.1, 0.58 - (away - 1) * 0.17);
  const blur = isActive ? 0 : Math.min(1.8, (away - 1) * 0.55);
  const tilt = Math.max(-30, Math.min(30, -distance * 9));
  row.style.transform =
    "perspective(560px) rotateX(" + tilt + "deg) scale(" + scale.toFixed(3) + ")";
  row.style.opacity = String(opacity);
  row.style.filter = blur ? "blur(" + blur.toFixed(2) + "px)" : "none";
  row.style.color = isActive ? "#ffe2cd" : "#e8e8ea";
  row.style.fontWeight = isActive ? "700" : "400";
  row.style.textShadow = isActive ? "0 0 18px rgba(255,170,120,.45)" : "none";
}

// One span per word, so the karaoke fill can colour each one separately.
function wordSpans(container, cue) {
  const spans = [];
  cue.words.forEach((word, i) => {
    if (i) container.append(" ");
    const span = document.createElement("span");
    span.textContent = word.text;
    container.append(span);
    spans.push(span);
  });
  return spans;
}

// Paint each word as sung, unsung, or part way, with a hard edge sweeping
// across the word. null puts the words back to plain text.
function paintWords(spans, progress) {
  spans.forEach((span, i) => {
    const p = progress ? progress[i] : null;
    const partial = p != null && p > 0 && p < 1;
    span.style.background = partial
      ? "linear-gradient(90deg," + SUNG + " " + (p * 100).toFixed(1) + "%," + UNSUNG + " " +
        (p * 100).toFixed(1) + "%)"
      : "none";
    span.style.webkitBackgroundClip = partial ? "text" : "";
    span.style.backgroundClip = partial ? "text" : "";
    span.style.color = p == null ? "" : partial ? "transparent" : p >= 1 ? SUNG : UNSUNG;
  });
}

function karaoke(node) {
  const state = node._songLrc;
  const cue = state.cues[state.active];
  if (!cue || !cue.words) return;
  const next = state.cues[state.active + 1];
  const progress = wordProgress(cue, next ? next.time : state.player.duration,
    state.player.currentTime);
  paintWords(cue.spans, progress);
  if (state.captionSpans) paintWords(state.captionSpans, progress);
}

// Smooth fill needs more than timeupdate's four ticks a second.
function runLoop(node) {
  const state = node._songLrc;
  cancelAnimationFrame(state.loop);
  const step = () => {
    if (state.player.paused) return;
    highlight(node);
    karaoke(node);
    state.loop = requestAnimationFrame(step);
  };
  state.loop = requestAnimationFrame(step);
}

function render(node, lrcText, audioUrl) {
  const state = node._songLrc;
  const { cues, title } = parseLrc(lrcText);
  if (state.recording) stopExport(node);
  Object.assign(state, { cues, title, active: -2, captionSpans: null });
  state.heading.textContent = title || "Untitled";
  state.reel.replaceChildren();
  state.caption.textContent = "";

  cues.forEach((cue) => {
    const row = document.createElement("div");
    row.style.cssText =
      "height:" + LINE_HEIGHT + "px;line-height:" + LINE_HEIGHT + "px;text-align:center;" +
      "font-size:15px;padding:0 14px;cursor:pointer;white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis;transform-origin:50% 50%;backface-visibility:hidden;" +
      "transition:transform .3s cubic-bezier(.22,.9,.24,1),opacity .3s,filter .3s," +
      "color .3s,font-weight .3s,text-shadow .3s;";
    if (cue.words) cue.spans = wordSpans(row, cue);
    else row.textContent = cue.text || "· · ·";

    row.addEventListener("click", () => {
      state.player.currentTime = cue.time;
      play(state);
    });
    state.reel.append(row);
    cue.row = row;
  });

  if (audioUrl) state.player.src = audioUrl;
  highlight(node, true);
}

function highlight(node, force) {
  const state = node._songLrc;
  if (!state || !state.cues.length) return;
  const index = activeCue(state.cues, state.player.currentTime);
  if (index === state.active && !force) return;
  const lineChanged = index !== state.active;
  const previous = state.cues[state.active];
  if (lineChanged && previous && previous.spans) paintWords(previous.spans, null);
  state.active = index;

  state.cues.forEach((cue, position) => {
    styleRow(cue.row, position - index, position === index);
  });

  // The visualizer keeps the current line as a caption.
  const cue = state.cues[index];
  if (lineChanged || force) {
    state.caption.replaceChildren();
    state.captionSpans = null;
    if (cue && cue.words) state.captionSpans = wordSpans(state.caption, cue);
    else if (cue) state.caption.textContent = cue.text || "· · ·";
  }
  if (lineChanged && cue && state.view === "visualizer" && state.caption.animate) {
    state.caption.animate(
      [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
      { duration: 320, easing: "ease-out" }
    );
  }
  karaoke(node);

  // Park the current line on the centre line of the frame.
  const centre = state.frame.clientHeight / 2;
  const target = (index < 0 ? 0 : index) * LINE_HEIGHT + LINE_HEIGHT / 2;
  state.reel.style.transform = "translateY(" + (centre - target).toFixed(1) + "px)";
}

// Saved workflows carry the chosen view and volume in the node's properties.
function restore(node) {
  const state = node._songLrc;
  if (!state) return;
  const saved = Number(node.properties.songLrcVolume);
  state.volume = isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 1;
  state.muted = false;
  applyVolume(state);
  setStyle(node, node.properties.songLrcStyle, false);
  setView(node, node.properties.songLrcView);
}

console.log("[SongLRC] music player loaded");

app.registerExtension({
  name: "SongLRC.MusicPlayer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "SongMusicPlayer") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated ? onCreated.apply(this, arguments) : undefined;
      this.properties = this.properties || {};
      const element = build(this);
      const player = document.createElement("audio");
      // No native controls; the transport below is drawn to match the node.
      player.preload = "auto";
      player.style.display = "none";
      this._songLrc.player = player;
      element.append(player, transport(this, player));

      this.addDOMWidget("player", "div", element, { serialize: false });
      this.size = [460, 380];

      player.addEventListener("timeupdate", () => highlight(this));
      player.addEventListener("seeked", () => highlight(this, true));
      player.addEventListener("play", () => runLoop(this));
      if (window.ResizeObserver) {
        new ResizeObserver(() => highlight(this, true)).observe(this._songLrc.frame);
      }
      restore(this);
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      restore(this);
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const state = this._songLrc;
      if (state) {
        state.player.pause();
        stopExport(this);
        state.visualizer.stop();
        cancelAnimationFrame(state.loop);
        if (state.graph) state.graph.context.close().catch(() => {});
      }
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      if (!this._songLrc || !message) return result;
      const file = message.audio && message.audio[0];
      this._songLrc.audioFile = file || null;
      const url = file ? api.apiURL("/view?" + new URLSearchParams(file).toString()) : "";
      render(this, message.lrc && message.lrc[0], url);
      return result;
    };
  },
});
