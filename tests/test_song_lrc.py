import json
import importlib.util
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch


NODE_PATH = Path(__file__).resolve().parents[1] / "song_lrc_node.py"
spec = importlib.util.spec_from_file_location("song_lrc_node", NODE_PATH)
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)


class SongLRCTimingTests(unittest.TestCase):
    def test_missing_model_title_is_derived_from_repeated_chorus_hook(self):
        raw = (
            "[verse]\nMidnight rhythm hits the floor\n"
            "[chorus]\nTake it far away\nNo pineapples in my pizza no no no\n"
            "[verse]\nSugar in the dough is wrong\n"
            "[chorus]\nTake it far away\nNo pineapples in my pizza no no no"
        )
        lyrics, title = node.SongLyricsClean().clean(raw)
        self.assertIn("[chorus]", lyrics)
        self.assertEqual(title, "No Pineapples In My Pizza")
        prefix, safe_title = node.SongFilename().prepare(title)
        self.assertEqual(prefix, "audio/songs/No Pineapples In My Pizza")
        self.assertEqual(safe_title, "No Pineapples In My Pizza")

    def test_explicit_model_title_still_wins(self):
        lyrics, title = node.SongLyricsClean().clean(
            "Title: Electric Orchard\n[verse]\nMidnight rhythm\n[chorus]\nTake it away"
        )
        self.assertEqual(title, "Electric Orchard")
        self.assertNotIn("Title:", lyrics)

    def test_empty_lyric_placeholder_is_not_sung_or_displayed(self):
        raw = "[verse]\n我想你\n[空歌词 25]\n[chorus]\nStill here\n空歌词 9"
        cleaned, _ = node.sanitize_generated_lyrics(raw)
        self.assertEqual(cleaned, "[verse]\n我想你\n[chorus]\nStill here")

    def test_missing_word_does_not_shift_later_lines(self):
        lines = ["Hold on to me", "I still believe", "Hold on to me"]
        words = [
            ("Hold", 1.0), ("on", 1.2), ("to", None), ("me", 1.7),
            ("I", 4.0), ("still", None), ("believe", 4.7),
            ("Hold", 8.0), ("on", 8.2), ("to", 8.4), ("me", 8.6),
        ]
        result = {"segments": [{"words": [
            {"word": word, "start": start, "end": None if start is None else start + 0.1}
            for word, start in words
        ]}]}
        evidence = node._line_evidence(result, lines)
        self.assertEqual([part[0] for part in evidence], [1.0, 4.0, 8.0])
        self.assertEqual([part[2] for part in evidence], [3, 2, 4])

    def test_catches_compressed_tail_at_slow_medium_and_fast_tempo(self):
        lines = ["One more line of singing"] * 10
        for step in (1.1, 2.6, 5.2):
            starts = [i * step for i in range(5)] + [155 + i * 0.08 for i in range(5)]
            self.assertEqual(node._collapsed_run(starts, lines), 5)

    def test_long_gap_clears_music_player(self):
        evidence = [(1.0, 3.0, 4), (18.0, 20.0, 4)]
        lrc = node._lrc_from_evidence(["First lyric", "Second lyric"], evidence,
                                      30.0, "Song", "Artist", 0.0)
        self.assertIn("[00:04.50]\n", lrc)
        self.assertIn("[00:21.50]\n", lrc)
        lyric_times = [float(m) * 60 + float(s) for m, s in
                       re.findall(r"\[(\d{2}):(\d{2}\.\d{2})\]", lrc)]
        self.assertEqual(lyric_times, sorted(lyric_times))

    def test_manual_scale_and_offset_are_applied_once(self):
        evidence = [(10.0, 12.0, 3), (20.0, 22.0, 3)]
        lrc = node._lrc_from_evidence(["First line", "Second line"], evidence,
                                      40.0, "Song", "Artist", 1.0, 1.1)
        self.assertIn("[00:12.00]First line", lrc)
        self.assertIn("[00:23.00]Second line", lrc)
        windows = node.line_windows("One line\nAnother line", 40.0, offset=1.0)
        self.assertEqual(windows[0][1], 1.0)

    def test_song_title_is_safe_for_audio_and_lrc_filename(self):
        self.assertEqual(node.safe_song_title('  Cold Drink: Summer / Night?  '),
                         "Cold Drink Summer Night")
        self.assertEqual(node.safe_song_title(""), "Generated Song")

    def test_matching_lrc_uses_advanced_audio_basename(self):
        with tempfile.TemporaryDirectory() as output_dir:
            previous = sys.modules.get("folder_paths")
            sys.modules["folder_paths"] = types.SimpleNamespace(
                get_output_directory=lambda: output_dir)
            try:
                prefix, safe_title = node.SongFilename().prepare("Summer: Road")
                audio_dir = os.path.join(output_dir, "audio", "songs")
                os.makedirs(audio_dir)
                audio_path = os.path.join(audio_dir, f"{safe_title}_00007.mp3")
                Path(audio_path).write_bytes(b"fake mp3")
                audio = {"waveform": torch.zeros(1, 2, 480), "sample_rate": 48000}
                result = node.SongSaveMatchingLRC().save(
                    audio, "[ti:Summer Road]\n[00:00.00]Hello", prefix)
            finally:
                if previous is None:
                    sys.modules.pop("folder_paths", None)
                else:
                    sys.modules["folder_paths"] = previous
            lrc_path = os.path.splitext(audio_path)[0] + ".lrc"
            self.assertTrue(os.path.exists(audio_path))
            self.assertTrue(os.path.exists(lrc_path))
            self.assertEqual(Path(audio_path).stem, Path(lrc_path).stem)
            self.assertIs(result["result"][0], audio)


    def _written(self, lrc):
        return [row for row in lrc.splitlines()
                if row.startswith("[") and "]" in row and row.split("]", 1)[1].strip()]

    def _starts(self, lrc):
        return [float(m) * 60 + float(s) for m, s in
                re.findall(r"\[(\d{2}):(\d{2}\.\d{2})\]\S", lrc)]

    def test_tied_closing_timestamps_keep_every_lyric_line(self):
        """Two closing ad-libs sharing one aligned time must both survive."""
        lines = ["Drain the glass", "Kill the process", "Silence", "Gone"]
        evidence = [(150.0, 151.0, 3), (153.0, 154.0, 3),
                    (162.0, 162.4, 1), (162.0, 162.9, 1)]
        lrc = node._lrc_from_evidence(lines, evidence, 180.0, "Song", "Artist", 0.0)
        self.assertEqual(len(self._written(lrc)), len(lines))
        starts = self._starts(lrc)
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(set(starts)), len(starts))

    def test_reversed_closing_timestamps_keep_every_lyric_line(self):
        lines = ["Drain the glass", "Kill the process", "Silence", "Gone"]
        evidence = [(150.0, 151.0, 3), (153.0, 154.0, 3),
                    (162.0, 162.4, 1), (161.5, 161.9, 1)]
        lrc = node._lrc_from_evidence(lines, evidence, 180.0, "Song", "Artist", 0.0)
        self.assertEqual(len(self._written(lrc)), len(lines))
        starts = self._starts(lrc)
        self.assertEqual(starts, sorted(starts))

    def test_untimed_lines_are_interpolated_not_dropped(self):
        """WhisperX leaves trailing ad-libs untimed; they are still real lyrics."""
        lines = ["Drain the glass", "Kill the process", "Silence", "Gone"]
        for evidence in (
            [(150.0, 151.0, 3), (153.0, 154.0, 3), (None, None, 0), (None, None, 0)],
            [(150.0, 151.0, 3), (None, None, 0), (162.0, 162.4, 1), (170.0, 170.9, 1)],
            [(None, None, 0), (153.0, 154.0, 3), (162.0, 162.4, 1), (170.0, 170.9, 1)],
        ):
            with self.subTest(evidence=evidence):
                lrc = node._lrc_from_evidence(lines, evidence, 180.0, "Song", "Artist", 0.0)
                self.assertEqual(len(self._written(lrc)), len(lines))
                starts = self._starts(lrc)
                self.assertEqual(starts, sorted(starts))
                self.assertLessEqual(starts[-1], 180.0)

    def test_every_written_timestamp_stays_inside_the_song(self):
        lines = ["One", "Two", "Three"]
        evidence = [(179.9, 180.0, 1), (179.95, 180.0, 1), (None, None, 0)]
        lrc = node._lrc_from_evidence(lines, evidence, 180.0, "Song", "Artist", 0.0)
        self.assertEqual(len(self._written(lrc)), len(lines))
        self.assertTrue(all(start <= 180.0 for start in self._starts(lrc)))


    def test_legacy_class_keys_still_resolve_but_are_hidden(self):
        """Workflows saved as ComfyUI-MiniMaxLRC store the old class keys."""
        for old, new in node._LEGACY_NAMES:
            with self.subTest(old=old):
                self.assertIn(old, node.NODE_CLASS_MAPPINGS)
                self.assertTrue(issubclass(node.NODE_CLASS_MAPPINGS[old],
                                           node.NODE_CLASS_MAPPINGS[new]))
                self.assertTrue(node.NODE_CLASS_MAPPINGS[old].DEPRECATED)
                self.assertFalse(getattr(node.NODE_CLASS_MAPPINGS[new], "DEPRECATED", False))

    def test_lyrics_can_be_typed_without_a_generator_connected(self):
        """The stock FL-YuE2 graph has no text generator to connect."""
        spec = node.SongLyricsClean.INPUT_TYPES()["required"]["text"][1]
        self.assertNotIn("forceInput", spec)
        self.assertEqual(spec["default"], "")
        title_spec = node.SongFilename.INPUT_TYPES()["required"]["title"][1]
        self.assertNotIn("forceInput", title_spec)

    def test_filename_derives_a_title_from_lyrics_when_none_is_given(self):
        lyrics = """[verse]
Cold rain on the interstate
[chorus]
Hold the line tonight
[verse]
Tail lights bleeding out
[chorus]
Hold the line tonight"""
        prefix, title = node.SongFilename().prepare("", "audio/songs", lyrics)
        self.assertEqual(title, "Hold The Line Tonight")
        self.assertEqual(prefix, "audio/songs/Hold The Line Tonight")

    def test_output_folder_is_configurable_and_normalised(self):
        self.assertEqual(node.SongFilename().prepare("My Song", "audio/yue2")[0],
                         "audio/yue2/My Song")
        self.assertEqual(node.SongFilename().prepare("My Song", "/audio/yue2/")[0],
                         "audio/yue2/My Song")
        self.assertEqual(node.SongFilename().prepare("My Song", "")[0],
                         "audio/songs/My Song")

    def test_artist_tag_is_omitted_when_blank(self):
        windows = [("A line", 1.0, 2.0)]
        self.assertNotIn("[ar:", node.format_lrc(windows, 30.0, "Song", "", "by"))
        self.assertIn("[ar:Someone]", node.format_lrc(windows, 30.0, "Song", "Someone", "by"))


    def test_bundled_workflow_runs_without_a_text_generator(self):
        """The stock FL-YuE2 graph has no generator, so lyrics must be typed."""
        path = NODE_PATH.parent / "example_workflows" / "yue2_song_to_lrc.json"
        graph = json.loads(path.read_text(encoding="utf-8"))
        by_id = {n["id"]: n for n in graph["nodes"]}
        types = {n["type"] for n in graph["nodes"]}
        self.assertLessEqual({"SongLyricsClean", "SongFilename", "SongLyricsToLRC",
                              "SongSaveMatchingLRC"}, types)
        self.assertIn("SaveAudioAdvanced", types, "native saver keeps the format controls")
        self.assertFalse(types & {"TextGenerate", "SparkStudioChat", "ShowText|pysssss"})
        # The pack must not depend on nodes from other packs to run.
        self.assertFalse(types & {"SaveText|pysssss", "FL_YuE2_ScoreEditor"})

        clean = next(n for n in graph["nodes"] if n["type"] == "SongLyricsClean")
        self.assertTrue(clean["widgets_values"][0].strip(), "ships with usable lyrics")
        self.assertIsNone(clean["inputs"][0]["link"], "text is typed, not connected")

        def target(link_id):
            for link in graph["links"]:
                if link[0] == link_id:
                    return by_id[link[3]]["type"], link[4]
            return None

        lyrics_out, title_out = clean["outputs"][0]["links"], clean["outputs"][1]["links"]
        self.assertEqual({target(i)[0] for i in lyrics_out},
                         {"FL_YuE2_Plan", "SongLyricsToLRC"},
                         "the sung words and the timed words are the same text")
        self.assertEqual({target(i)[0] for i in title_out}, {"SongFilename"})

        filename = next(n for n in graph["nodes"] if n["type"] == "SongFilename")
        self.assertEqual({target(i)[0] for i in filename["outputs"][0]["links"]},
                         {"SaveAudioAdvanced", "SongSaveMatchingLRC", "SongSaveLRC"},
                         "audio and LRC share one prefix, so names always match")
        self.assertIn("SongSaveLRC", types, "the pack saves its own LRC, with no outside node")

        for item in graph["nodes"]:
            if item["type"].startswith("Song"):
                self.assertTrue(item.get("color"), item["type"] + " needs a colour")

        lrc = next(n for n in graph["nodes"] if n["type"] == "SongLyricsToLRC")
        structure = next(i for i in lrc["inputs"] if i["name"] == "structure")
        self.assertIsNotNone(structure["link"], "score timing is wired by default")
        audio = next(i for i in lrc["inputs"] if i["name"] == "audio")
        self.assertIsNotNone(audio["link"], "forced alignment needs the audio")


    def test_save_lrc_auto_writes_its_own_numbered_file(self):
        """It must not need an audio file to already exist."""
        with tempfile.TemporaryDirectory() as output_dir:
            previous = sys.modules.get("folder_paths")
            sys.modules["folder_paths"] = types.SimpleNamespace(
                get_output_directory=lambda: output_dir)
            try:
                first = node.SongSaveLRC().save("[00:00.00]One", "audio/songs/My Song")
                second = node.SongSaveLRC().save("[00:00.00]Two", "audio/songs/My Song")
            finally:
                if previous is None:
                    sys.modules.pop("folder_paths", None)
                else:
                    sys.modules["folder_paths"] = previous
            self.assertEqual(first["result"][0], "audio/songs/My Song_00001.lrc")
            self.assertEqual(second["result"][0], "audio/songs/My Song_00002.lrc")
            written = Path(output_dir) / "audio" / "songs" / "My Song_00002.lrc"
            self.assertEqual(written.read_text(encoding="utf-8"), "[00:00.00]Two")

    def test_save_lrc_auto_refuses_to_escape_the_output_folder(self):
        with tempfile.TemporaryDirectory() as output_dir:
            previous = sys.modules.get("folder_paths")
            sys.modules["folder_paths"] = types.SimpleNamespace(
                get_output_directory=lambda: output_dir)
            try:
                with self.assertRaises(ValueError):
                    node.SongSaveLRC().save("x", "../../escaped")
            finally:
                if previous is None:
                    sys.modules.pop("folder_paths", None)
                else:
                    sys.modules["folder_paths"] = previous

    def test_every_node_has_a_colour(self):
        """The UI file must cover each node the pack registers."""
        palette = (NODE_PATH.parent / "web" / "colors.js").read_text(encoding="utf-8")
        for name in node.NODE_CLASS_MAPPINGS:
            if name.startswith("MiniMax"):
                continue
            with self.subTest(name=name):
                self.assertIn(name, palette)


if __name__ == "__main__":
    unittest.main()
