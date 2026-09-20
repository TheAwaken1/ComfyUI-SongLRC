import { app } from "../../scripts/app.js";

// A violet-to-magenta run for the lyric pipeline, teal for the two savers,
// so a SongLRC chain reads as one group on a busy canvas.
const PALETTE = {
  SongLyricsClean: { color: "#4a2d7a", bgcolor: "#241640" },
  SongFilename: { color: "#6a2d7a", bgcolor: "#341640" },
  SongLyricsToLRC: { color: "#8a2d6a", bgcolor: "#43163a" },
  SongSaveLRC: { color: "#1f6b5a", bgcolor: "#103a31" },
  SongSaveMatchingLRC: { color: "#17605f", bgcolor: "#0d3535" },
};

console.log("[SongLRC] node colors loaded");

app.registerExtension({
  name: "SongLRC.Colors",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const theme = PALETTE[nodeData.name];
    if (!theme) return;
    nodeType.prototype.color = theme.color;
    nodeType.prototype.bgcolor = theme.bgcolor;
  },
});
