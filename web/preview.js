import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// Show the finished LRC on the saver nodes, the way a text saver would, so
// the timestamps can be checked without opening the file.
const SHOWS_LRC = ["SongSaveLRC", "SongSaveMatchingLRC"];

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
      const saved = message.saved && message.saved.length ? message.saved[0] : "";
      widget.value = saved ? `# ${saved}\n${lines.join("")}` : lines.join("");
      requestAnimationFrame(() => {
        const size = this.computeSize();
        this.setSize([Math.max(this.size[0], size[0]), Math.max(this.size[1], size[1])]);
        app.graph.setDirtyCanvas(true, false);
      });
      return result;
    };
  },
});
