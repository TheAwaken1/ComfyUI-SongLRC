import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { parseLrc, activeCue } from "./lrc.js";

// Audio plus its own LRC, highlighted line by line. Clicking a line seeks.

function build(node) {
  const root = document.createElement("div");
  root.style.cssText =
    "display:flex;flex-direction:column;gap:6px;height:100%;min-height:0;" +
    "padding:6px;box-sizing:border-box;font-family:inherit;";

  const heading = document.createElement("div");
  heading.style.cssText =
    "font-size:12px;opacity:0.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  heading.textContent = "Run the graph to load a song.";

  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "auto";
  player.style.cssText = "width:100%;flex:0 0 auto;";

  const lyrics = document.createElement("div");
  lyrics.style.cssText =
    "flex:1 1 auto;min-height:60px;overflow-y:auto;line-height:1.55;font-size:13px;" +
    "padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.25);";

  root.append(heading, player, lyrics);
  node._songLrc = { root, heading, player, lyrics, cues: [], active: -1 };
  return root;
}

function render(node, lrcText, audioUrl) {
  const state = node._songLrc;
  const { cues, title } = parseLrc(lrcText);
  state.cues = cues;
  state.active = -1;
  state.heading.textContent = title || "Untitled";
  state.lyrics.replaceChildren();

  cues.forEach((cue, index) => {
    const row = document.createElement("div");
    // A cue with no words is an instrumental gap; keep the space, not the text.
    row.textContent = cue.text || " ";
    row.style.cssText =
      "padding:2px 4px;border-radius:4px;cursor:pointer;opacity:0.55;transition:opacity .15s;";
    row.addEventListener("click", () => {
      state.player.currentTime = cue.time;
      state.player.play().catch(() => {});
    });
    state.lyrics.append(row);
    cue.row = row;
    cue.index = index;
  });

  if (audioUrl) state.player.src = audioUrl;
}

function highlight(node) {
  const state = node._songLrc;
  if (!state || !state.cues.length) return;
  const index = activeCue(state.cues, state.player.currentTime);
  if (index === state.active) return;
  if (state.active >= 0) {
    const previous = state.cues[state.active].row;
    previous.style.opacity = "0.55";
    previous.style.background = "transparent";
    previous.style.fontWeight = "normal";
  }
  state.active = index;
  if (index < 0) return;
  const row = state.cues[index].row;
  row.style.opacity = "1";
  row.style.background = "rgba(255,255,255,0.10)";
  row.style.fontWeight = "600";
  const box = state.lyrics;
  const offset = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
  box.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
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
      this.addDOMWidget("player", "div", element, { serialize: false });
      this.size = [380, 320];
      this._songLrc.player.addEventListener("timeupdate", () => highlight(this));
      this._songLrc.player.addEventListener("seeked", () => highlight(this));
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
