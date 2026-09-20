# ComfyUI-SongLRC

Turn generated song lyrics into a timed `.lrc` file that is saved beside the audio,
with a matching name and counter.

```
output/audio/songs/Hold The Line Tonight_00007.mp3
output/audio/songs/Hold The Line Tonight_00007.lrc
```

Built and tested against [ComfyUI-FL-YuE2](https://github.com/filliptm/ComfyUI-FL-YuE2).
It also works with MiniMax Music 3 and, in principle, any node chain that produces
lyrics plus an `AUDIO` output.

This pack was previously called **ComfyUI-MiniMaxLRC**. See Migrating below.

## What it gives you

- Real per-line timestamps from forced alignment when WhisperX is installed
- Score-aware timing from a YuE2 ABC score when it is not
- A song title taken from a `Title:` line, or derived from the repeated hook
- Audio and LRC written with the identical name and five digit counter
- ComfyUI's own Save Audio (Advanced) keeps working, so FLAC, MP3 and Opus
  quality controls are untouched

## Install

Through ComfyUI-Manager, search for `ComfyUI-SongLRC`.

Or clone it:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/TheAwaken1/ComfyUI-SongLRC
pip install -r ComfyUI-SongLRC/requirements.txt
```

Restart ComfyUI.

## The nodes

| Node | Purpose |
|------|---------|
| Lyrics Clean | Strips titles, markdown and stray tags. Outputs clean lyrics and a title. |
| Song Filename | Turns a title into `<folder>/<title>` for Save Audio (Advanced). |
| Lyrics to LRC | Times the lyrics against the audio and writes the LRC text. |
| Save Matching LRC | Writes the LRC next to the audio file that was just saved. |

## Using it

Load `example_workflows/score_editor_to_song_with_lrc.json`. It is the stock FL-YuE2
`score_editor_to_song` graph with the four nodes added and nothing else changed.

**You do not need a text generator.** Type or paste your lyrics into Lyrics Clean.
Its lyrics output feeds both the Compose node and Lyrics to LRC, so the words that
get sung and the words that get timed can never drift apart. Its title output feeds
Song Filename.

If you do use a generator, such as a Qwen or Spark Studio node, connect it to the
Lyrics Clean text input instead of typing. Everything downstream is identical.

Leave the title field on Song Filename blank and it derives one from the repeated
chorus line. Fill it in to name the song yourself.

### Timing quality

Three methods, best first. The node picks the best one available automatically.

1. **Forced alignment.** Connect the final `AUDIO` to Lyrics to LRC and install
   WhisperX. This gives real timestamps.
2. **Score timing.** Connect the Compose node's `score_abc` output to the
   `structure` input. Sections are placed using the score's tempo and bar counts
   rather than being spread evenly. The example workflow wires this for you.
3. **Even timing.** The fallback. Lyrics are spread across the song with an
   allowance for the intro and outro.

If timings drift, adjust `timing_scale` above 1 when lyrics run early and below 1
when they run late. Use `offset_seconds` to shift everything.

### Installing WhisperX safely

A plain `pip install whisperx` often replaces your CUDA PyTorch with a CPU-only
build and breaks ComfyUI. Install it without touching torch:

```bash
pip install whisperx --no-deps
pip install faster-whisper ctranslate2 nltk pandas pyannote.audio omegaconf
```

Then confirm CUDA still works:

```bash
python -c "import torch; print(torch.cuda.is_available())"
```

If that prints `False`, reinstall the CUDA torch build you had before. Skipping
WhisperX is fine; the nodes fall back to score or even timing.

## Migrating from ComfyUI-MiniMaxLRC

Old workflows keep loading. The four previous class names are registered as hidden
aliases pointing at the renamed nodes, so nothing turns into a red missing node.

Two changes to know about:

- The default output folder is now `audio/songs` rather than `audio/YuE2`. Song
  Filename has a `folder` widget, so set it back if you want the old path.
- The LRC `ar:` tag is now blank by default and is left out when empty, instead of
  claiming every song was made by MiniMax Music 3.

Remove the old `ComfyUI-MiniMaxLRC` folder after installing this one, or the two
packs will fight over the same class names.

## Running it from code

The nodes run inside ComfyUI, so drive them through ComfyUI's API. Export your
graph with **Workflow, Export (API)** first, then post it.

```bash
curl -X POST http://127.0.0.1:8188/prompt -H "Content-Type: application/json" -d @workflow_api.json
```

```python
import json, urllib.request

graph = json.load(open("workflow_api.json", encoding="utf-8"))
# Node 8 is Lyrics Clean in the bundled example.
graph["8"]["inputs"]["text"] = "[verse]\nNew words here\n[chorus]\nAnd a hook"
body = json.dumps({"prompt": graph}).encode()
req = urllib.request.Request("http://127.0.0.1:8188/prompt", data=body,
                             headers={"Content-Type": "application/json"})
print(json.load(urllib.request.urlopen(req))["prompt_id"])
```

```javascript
const graph = await (await fetch("./workflow_api.json")).json();
graph["8"].inputs.text = "[verse]\nNew words here\n[chorus]\nAnd a hook";
const r = await fetch("http://127.0.0.1:8188/prompt", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: graph }),
});
console.log((await r.json()).prompt_id);
```

Poll `GET /history/<prompt_id>` for completion. The LRC lands in your output folder
next to the audio; Save Matching LRC also reports the path it wrote.

## Tests

```bash
python -m unittest discover -s tests
```

## License

MIT
