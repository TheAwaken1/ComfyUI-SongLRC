import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
import { parseLrc } from "./lrc.js";

// Show the finished LRC on the saver nodes: the title, then the timed lines.
// The length and byline tags belong in the file, not on screen.
const SHOWS_LRC = ["SongSaveLRC", "SongSaveMatchingLRC"];

const TIMED = /^\[\d/;
// Word tags make the file karaoke-ready but unreadable on the node.
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.,]\d{1,3})?>/g;

function tidy(text) {
  const { title } = parseLrc(text);
  const body = String(text || "")
    .split(/\r?\n/)
    .filter((line) => TIMED.test(line.trim()))
    .map((line) => line.trim().replace(WORD_TAG, "").replace(/\s+/g, " "))
    .join("\n");
  return (title || "Untitled") + "\n\n" + body;
}

app.registerExtension({
  name: "SongLRC.Preview",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!SHOWS_LRC.includes(nodeData.name)) return;

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted ? onExecuted.apply(this, arguments) : undefined;
      const lines = message && message.text;
      if (!lines || !lines.length) return result;

      let widget = this.widgets && this.widgets.find((w) => w.name === "lrc_preview");
      if (!widget) {
        widget = ComfyWidgets["STRING"](
          this, "lrc_preview", ["STRING", { multiline: true }], app
        ).widget;
        widget.inputEl.readOnly = true;
        widget.inputEl.style.opacity = 0.85;
        widget.serializeValue = () => undefined;
      }
      widget.value = tidy(lines.join(""));
      requestAnimationFrame(() => {
        const size = this.computeSize();
        this.setSize([Math.max(this.size[0], size[0]), Math.max(this.size[1], size[1])]);
        app.graph.setDirtyCanvas(true, false);
      });
      return result;
    };
  },
});
