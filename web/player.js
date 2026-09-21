import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { parseLrc, activeCue } from "./lrc.js";

// A lyric wheel: the current line sits centred and large, neighbours recede
// above and below on a tilted arc, and the far ones fade into the frame.

const LINE_HEIGHT = 30;

function build(node) {
  const root = document.createElement("div");
  root.style.cssText =
    "display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;" +
    "padding:8px;box-sizing:border-box;font-family:inherit;";

  const heading = document.createElement("div");
  heading.style.cssText =
    "font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.6;" +
    "text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  heading.textContent = "Run the graph to load a song";

  const frame = document.createElement("div");
  frame.style.cssText =
    "position:relative;flex:1 1 auto;min-height:120px;overflow:hidden;border-radius:12px;" +
    "background:radial-gradient(130% 90% at 50% 50%,rgba(150,47,58,.34) 0%," +
    "rgba(138,61,20,.20) 38%,rgba(6,4,10,.86) 100%);" +
    "box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),inset 0 14px 34px rgba(0,0,0,.55)," +
    "inset 0 -14px 34px rgba(0,0,0,.55);" +
    "-webkit-mask-image:linear-gradient(to bottom,transparent 0%,#000 22%,#000 78%,transparent 100%);" +
    "mask-image:linear-gradient(to bottom,transparent 0%,#000 22%,#000 78%,transparent 100%);";

  const glow = document.createElement("div");
  glow.style.cssText =
    "position:absolute;left:8%;right:8%;top:50%;height:" + LINE_HEIGHT + "px;" +
    "transform:translateY(-50%);pointer-events:none;border-radius:8px;" +
    "background:linear-gradient(90deg,transparent,rgba(255,196,150,.10),transparent);";

  const reel = document.createElement("div");
  reel.style.cssText =
    "position:absolute;left:0;right:0;top:0;transform-style:preserve-3d;" +
    "transition:transform .34s cubic-bezier(.22,.9,.24,1);will-change:transform;";

  frame.append(glow, reel);
  root.append(heading, frame);
  node._songLrc = { root, heading, frame, reel, cues: [], active: -2 };
  return root;
}

function transport(node, player) {
  const bar = document.createElement("div");
  bar.style.cssText =
    "display:flex;align-items:center;gap:10px;flex:0 0 auto;padding:2px 2px 0;";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "\u25b6";
  button.style.cssText =
    "width:30px;height:30px;flex:0 0 auto;border:0;border-radius:50%;cursor:pointer;" +
    "color:#ffe2cd;background:rgba(150,47,58,.55);font-size:12px;line-height:30px;" +
    "box-shadow:inset 0 0 0 1px rgba(255,255,255,.14);transition:background .2s;";
  button.addEventListener("click", () => {
    if (player.paused) player.play().catch(() => {});
    else player.pause();
  });

  const track = document.createElement("div");
  track.style.cssText =
    "position:relative;flex:1 1 auto;height:6px;border-radius:3px;cursor:pointer;" +
    "background:rgba(255,255,255,.12);overflow:hidden;";
  const fill = document.createElement("div");
  fill.style.cssText =
    "position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:3px;" +
    "background:linear-gradient(90deg,#8a3d14,#ffb27a);";
  track.append(fill);

  function seek(event) {
    const box = track.getBoundingClientRect();
    if (!box.width || !isFinite(player.duration)) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    player.currentTime = ratio * player.duration;
  }
  track.addEventListener("pointerdown", (event) => {
    track.setPointerCapture(event.pointerId);
    seek(event);
    const move = (moved) => seek(moved);
    const stop = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", stop);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", stop);
  });

  player.addEventListener("timeupdate", () => {
    if (!isFinite(player.duration) || !player.duration) return;
    fill.style.width = ((player.currentTime / player.duration) * 100).toFixed(2) + "%";
  });
  player.addEventListener("play", () => {
    button.textContent = "\u23f8";
  });
  player.addEventListener("pause", () => {
    button.textContent = "\u25b6";
  });
  player.addEventListener("ended", () => {
    button.textContent = "\u25b6";
  });

  bar.append(button, track);
  return bar;
}


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

function render(node, lrcText, audioUrl) {
  const state = node._songLrc;
  const { cues, title } = parseLrc(lrcText);
  state.cues = cues;
  state.active = -2;
  state.heading.textContent = title || "Untitled";
  state.reel.replaceChildren();

  cues.forEach((cue) => {
    const row = document.createElement("div");
    row.textContent = cue.text || "\u00b7 \u00b7 \u00b7";
    row.style.cssText =
      "height:" + LINE_HEIGHT + "px;line-height:" + LINE_HEIGHT + "px;text-align:center;" +
      "font-size:15px;padding:0 14px;cursor:pointer;white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis;transform-origin:50% 50%;backface-visibility:hidden;" +
      "transition:transform .3s cubic-bezier(.22,.9,.24,1),opacity .3s,filter .3s," +
      "color .3s,font-weight .3s,text-shadow .3s;";
    row.addEventListener("click", () => {
      state.player.currentTime = cue.time;
      state.player.play().catch(() => {});
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
  state.active = index;

  state.cues.forEach((cue, position) => {
    styleRow(cue.row, position - index, position === index);
  });

  // Park the current line on the centre line of the frame.
  const centre = state.frame.clientHeight / 2;
  const target = (index < 0 ? 0 : index) * LINE_HEIGHT + LINE_HEIGHT / 2;
  state.reel.style.transform = "translateY(" + (centre - target).toFixed(1) + "px)";
}

console.log("[SongLRC] music player loaded");

app.registerExtension({
  name: "SongLRC.MusicPlayer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "SongMusicPlayer") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated ? onCreated.apply(this, arguments) : undefined;
      const element = build(this);
      const player = document.createElement("audio");
      // No native controls: they carry a clock, and the point here is the words.
      player.preload = "auto";
      player.style.display = "none";
      element.append(player, transport(this, player));
      this._songLrc.player = player;

      this.addDOMWidget("player", "div", element, { serialize: false });
      this.size = [400, 360];

      player.addEventListener("timeupdate", () => highlight(this));
      player.addEventListener("seeked", () => highlight(this, true));
      if (window.ResizeObserver) {
        new ResizeObserver(() => highlight(this, true)).observe(this._songLrc.frame);
      }
      return result;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      if (!this._songLrc || !message) return result;
      const file = message.audio && message.audio[0];
      const url = file ? api.apiURL("/view?" + new URLSearchParams(file).toString()) : "";
      render(this, message.lrc && message.lrc[0], url);
      return result;
    };
  },
});
