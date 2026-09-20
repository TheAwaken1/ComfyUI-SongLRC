import { app } from "../../scripts/app.js";

// One colour for every node in the pack: a burnt-orange title over a deep
// crimson body. Uniform on purpose, so a SongLRC chain is recognisable at a
// glance on a canvas full of other node packs.
const THEME = { color: "#8a3d14", bgcolor: "#4a161c" };

const NODES = [
  "SongLyricsClean",
  "SongFilename",
  "SongLyricsToLRC",
  "SongSaveLRC",
  "SongSaveMatchingLRC",
  "SongMusicPlayer",
];

function paint(node) {
  node.color = THEME.color;
  node.bgcolor = THEME.bgcolor;
}

console.log("[SongLRC] node colors loaded");

app.registerExtension({
  name: "SongLRC.Colors",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODES.includes(nodeData.name)) return;

    // Older frontends read these off the prototype.
    nodeType.prototype.color = THEME.color;
    nodeType.prototype.bgcolor = THEME.bgcolor;

    // Newer ones only honour a value set on the node itself.
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onCreated ? onCreated.apply(this, arguments) : undefined;
      paint(this);
      return result;
    };

    // Loading a workflow restores saved colours, so only fill in the gaps.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      if (!info || !info.color) paint(this);
      return result;
    };
  },
});
