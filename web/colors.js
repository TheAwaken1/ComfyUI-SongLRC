import { app } from "../../scripts/app.js";

// SongLRC's own palette: a warm amber-to-crimson run along the lyric path,
// deep blue for the two savers. Chosen to sit apart from the node packs it
// commonly shares a canvas with.
const PALETTE = {
  SongLyricsClean: { color: "#7a4a12", bgcolor: "#3d2408" },
  SongFilename: { color: "#8a3d14", bgcolor: "#451d09" },
  SongLyricsToLRC: { color: "#962f3a", bgcolor: "#4a161c" },
  SongSaveLRC: { color: "#1e3a6b", bgcolor: "#0f1d38" },
  SongSaveMatchingLRC: { color: "#16305c", bgcolor: "#0b1730" },
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
