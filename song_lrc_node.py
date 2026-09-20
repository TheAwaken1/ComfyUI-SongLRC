import re
import os
import tempfile
import unicodedata
from difflib import SequenceMatcher
import numpy as np

_TAG = re.compile(r"^\[([^\]]+)\]$")
_NON_SINGING = {"intro", "silence", "interlude", "instrumental", "solo", "outro"}
_SECTION_WORDS = (
    "verse", "chorus", "bridge", "intro", "outro", "hook", "refrain",
    "pre-chorus", "prechorus", "pre chorus",
)
_SECTION_LINE = re.compile(
    r"^\s*[\*_~`]*\s*\[+\s*("
    + "|".join(_SECTION_WORDS)
    + r")(?:\s*\d+)?(?:\s*[-–:]\s*x?\d+)?\s*\]+\s*[\*_~`]*\s*$",
    re.IGNORECASE,
)
_TITLE_LINE = re.compile(
    r"^\s*[\*_~`]*\s*(?:title|song title|name)\s*[:：]\s*[\"'“”*_~`]*\s*(.+?)\s*[\"'“”*_~`]*\s*$",
    re.IGNORECASE,
)
_META_LINE = re.compile(
    r"^\s*[\*_~`]*\s*(?:artist|album|subtitle|genre|author|by|lyrics by|written by)\s*[:：]",
    re.IGNORECASE,
)
_SEPARATOR = re.compile(r"^[\s*\-_=~#]+$")


def _strip_md(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = text.replace("**", "").replace("__", "")
    text = text.replace("*", "").replace("_", "").replace("`", "")
    text = re.sub(r"\s+", " ", text).strip(" \t-–—")
    return text


def sanitize_generated_lyrics(raw: str) -> tuple[str, str]:
    """Turn a model's markdown song dump into clean singable lyrics.

    Drops Title/subtitle/---, unwraps **[VERSE 1 - x2]**, and keeps only
    [verse]/[chorus]/... tags plus singable lines. Returns (lyrics, title).
    """
    title = ""
    blocks: list[str] = []
    seen_section = False
    for raw_line in (raw or "").replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if _SEPARATOR.match(line):
            continue
        title_match = _TITLE_LINE.match(line)
        if title_match:
            if not title:
                title = _strip_md(title_match.group(1))
            continue
        if _META_LINE.match(line):
            continue
        stripped = _strip_md(line)
        if not stripped:
            continue
        if re.fullmatch(r"[\[【(（]?\s*(?:空\s*歌词|empty\s+lyrics?)\s*(?:[#:]?\s*\d+)?\s*[\]】)）]?",
                        stripped, flags=re.IGNORECASE):
            # YuE/Qwen can expose an internal marker for an intentionally
            # empty vocal slot. It is metadata, not a lyric to display/sing.
            continue
        # Parenthetical subtitle under the title, e.g. (An Emo Dog Disaster Anthem)
        if not seen_section and re.match(r"^\([^)]+\)$", stripped):
            continue
        sec = _SECTION_LINE.match(line) or _SECTION_LINE.match(stripped)
        if sec:
            seen_section = True
            name = _canon_section(sec.group(1))
            blocks.append(f"[{name}]")
            continue
        if re.match(r"^\[+[^\]]+\]+$", stripped):
            # Unknown [tag] — skip rather than sing it
            continue
        if len(stripped) < 2 or stripped in "()[]{}…":
            continue
        seen_section = True
        blocks.append(stripped)
    lyrics = "\n".join(blocks).strip()
    return lyrics, title


def derive_song_title(lyrics: str) -> str:
    """Derive a short hook-based title when the lyrics carry no Title: line."""
    candidates: list[tuple[str, str, int, str]] = []
    section = ""
    counts: dict[str, int] = {}
    for index, raw_line in enumerate((lyrics or "").splitlines()):
        line = _strip_md(raw_line)
        if not line:
            continue
        section_match = _SECTION_LINE.match(line)
        if section_match:
            section = _canon_section(section_match.group(1))
            continue
        words = re.findall(r"\w+(?:['’]\w+)?", line, flags=re.UNICODE)
        if len(words) < 2:
            continue
        key = " ".join(word.casefold() for word in words)
        counts[key] = counts.get(key, 0) + 1
        candidates.append((line, section, index, key))

    if not candidates:
        return "Generated Song"

    line, _section, _index, _key = max(
        candidates,
        key=lambda item: (
            counts[item[3]],
            item[1] == "chorus",
            min(len(item[0].split()), 8),
            -item[2],
        ),
    )
    words = re.findall(r"\w+(?:['’]\w+)?", line, flags=re.UNICODE)
    while len(words) > 3 and words[-1].casefold() in {"oh", "ooh", "yeah", "no", "la", "hey"}:
        words.pop()
    words = words[:6]
    title = " ".join(
        word if (word.isupper() and len(word) > 1) else word[:1].upper() + word[1:]
        for word in words
    )
    return title or "Generated Song"


def _canon_section(name: str) -> str:
    name = (name or "").strip().lower()
    name = re.sub(r"\s+\d+$", "", name)
    if "chorus" in name or name in ("hook", "refrain"):
        return "chorus"
    if name in ("pre-chorus", "prechorus"):
        return "pre-chorus"
    if name in ("verse", "bridge"):
        return name
    if name in _NON_SINGING:
        return name
    return name or "verse"


def parse_lyric_blocks(lyrics: str) -> list[tuple[str, list[str]]]:
    cleaned, _title = sanitize_generated_lyrics(lyrics)
    source = cleaned or lyrics
    blocks: list[tuple[str, list[str]]] = []
    name = "verse"
    bucket: list[str] = []
    for raw in (source or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        match = _TAG.match(line)
        if match:
            if bucket:
                blocks.append((name, bucket))
                bucket = []
            name = _canon_section(match.group(1))
            continue
        bucket.append(line)
    if bucket:
        blocks.append((name, bucket))
    return blocks


_ABC_EVENT = re.compile(
    r'"(?:[^"\n]*)"|'
    r"\[K:[^\]]*\]|"
    r"(?P<note>[A-Ga-gzZ])"
    r"(?P<oct>[,']*)(?P<dur>\d*)(?P<tie>-?)"
)


def _abc_headers(text: str) -> tuple[float, int, int, int]:
    bpm, num, den, lden = 120.0, 4, 4, 8
    for raw in (text or "").splitlines():
        if raw.startswith("Q:"):
            match = (re.search(r"1/4\s*=\s*(\d+(?:\.\d+)?)", raw)
                     or re.search(r"=\s*(\d+(?:\.\d+)?)", raw)
                     or re.search(r"(\d+(?:\.\d+)?)\s*$", raw))
            if match:
                bpm = float(match.group(1))
        elif raw.startswith("M:"):
            try:
                num, den = map(int, raw[2:].strip().split("/", 1))
            except Exception:
                pass
        elif raw.startswith("L:"):
            match = re.match(r"L:1/(\d+)", raw.strip())
            if match:
                lden = int(match.group(1))
    return bpm, num, den, lden


def _quarters(units: int, lden: int) -> float:
    return float(units) * 4.0 / max(lden, 1)


def vocal_note_spans(text: str) -> tuple[list[tuple[float, float, str]], float, float]:
    """Vocal note [start, end) in seconds, plus (bpm, score_end_seconds)."""
    if not text:
        return [], 120.0, 0.0
    bpm, num, den, lden = _abc_headers(text)
    bar_q = 4.0 * num / max(den, 1)
    sec_per_q = 60.0 / max(bpm, 1e-6)
    voice = ""
    section = "intro"
    t = 0.0
    notes: list[tuple[float, float, str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("%"):
            label = re.sub(r"^%+", "", line).strip()
            label = re.split(r"[^A-Za-z]+", label)[0].lower() if label else section
            section = _canon_section(label)
            continue
        if line.startswith("V:"):
            voice = line[2:].strip().split()[0]
            continue
        if re.match(r"^[A-Za-z]:", line):
            continue
        if "vocal" not in voice.lower():
            continue
        for part in re.split(r"\|+", line):
            chunk = part.strip()
            if not chunk:
                continue
            z_full = re.match(r"^Z(\d*)$", chunk)
            if z_full:
                bars = int(z_full.group(1) or "1")
                t += bars * bar_q
                continue
            cursor = 0
            while cursor < len(chunk):
                if chunk[cursor].isspace():
                    cursor += 1
                    continue
                match = _ABC_EVENT.match(chunk, cursor)
                if not match:
                    cursor += 1
                    continue
                cursor = match.end()
                if match.group("note") is None:
                    continue
                note = match.group("note")
                units = int(match.group("dur") or "1")
                dur_q = _quarters(units, lden)
                if note in "zZ":
                    if note == "Z":
                        dur_q = bar_q * max(units, 1)
                    t += dur_q
                    continue
                start, end = t, t + dur_q
                notes.append((start * sec_per_q, end * sec_per_q, section))
                t += dur_q
    score_end = t * sec_per_q
    return notes, bpm, score_end


def _cluster_phrases(notes: list[tuple[float, float, str]], gap: float = 0.38):
    phrases: list[tuple[float, float]] = []
    for start, end, _section in notes:
        if phrases and start - phrases[-1][1] <= gap:
            phrases[-1] = (phrases[-1][0], max(phrases[-1][1], end))
        else:
            phrases.append((start, end))
    return phrases


def _fit_tempo(score_end: float, audio: float) -> float:
    """Nudge written ABC tempo to the rendered audio when they nearly match.

    Large mismatches are truncation (max_duration), not a tempo change — keep 1.0.
    """
    if score_end < 1.0 or audio < 1.0:
        return 1.0
    ratio = audio / score_end
    if 0.84 <= ratio <= 1.16:
        return ratio
    return 1.0


def _map_lines_to_phrases(lines: list[str], phrases: list[tuple[float, float]],
                          start: float, end: float) -> list[tuple[str, float, float]]:
    if not lines:
        return []
    if not phrases:
        step = (end - start) / max(len(lines), 1)
        return [(line, start + step * i, start + step * (i + 1))
                for i, line in enumerate(lines)]
    phrases = [(max(start, a), min(end, b)) for a, b in phrases if b > start and a < end]
    if not phrases:
        step = (end - start) / max(len(lines), 1)
        return [(line, start + step * i, start + step * (i + 1))
                for i, line in enumerate(lines)]
    n_lines, n_ph = len(lines), len(phrases)
    out: list[tuple[str, float, float]] = []
    if n_ph == n_lines:
        pairs = list(zip(lines, phrases))
    elif n_ph > n_lines:
        # Merge extra phrases into the lyric lines by duration.
        sizes = [1] * n_lines
        extra = n_ph - n_lines
        longest = sorted(range(n_lines), key=lambda i: phrases[min(i, n_ph - 1)][1] - phrases[min(i, n_ph - 1)][0], reverse=True)
        for k in range(extra):
            sizes[longest[k % n_lines]] += 1
        idx = 0
        for line, count in zip(lines, sizes):
            group = phrases[idx:idx + count]
            idx += count
            out.append((line, group[0][0], group[-1][1]))
        return out
    else:
        # Split long phrases across extra lyric lines.
        sizes = [1] * n_ph
        extra = n_lines - n_ph
        longest = sorted(range(n_ph), key=lambda i: phrases[i][1] - phrases[i][0], reverse=True)
        for k in range(extra):
            sizes[longest[k % n_ph]] += 1
        li = 0
        for ph, count in zip(phrases, sizes):
            a, b = ph
            step = (b - a) / count
            for j in range(count):
                if li >= n_lines:
                    break
                out.append((lines[li], a + step * j, a + step * (j + 1)))
                li += 1
        return out
    return [(line, a, b) for line, (a, b) in pairs]


def parse_abc_structure(text: str, duration: float) -> list[tuple[float, float, str]]:
    """Turn a YuE2/Score Editor ABC (Q:, % verse, V: Vocal) into timed sections.

    YuE2 ``max_duration`` clips the end of the song rather than stretching the
    score, so ABC times are used as wall-clock seconds and clipped to audio.
    """
    if not re.search(r"(?m)^(?:X:|V:|%\s*(?:intro|verse|chorus|bridge|outro))", text or "", re.I):
        return []
    bpm = 120.0
    num, den = 4, 4
    for raw in (text or "").splitlines():
        if raw.startswith("Q:"):
            match = re.search(r"=\s*(\d+(?:\.\d+)?)", raw) or re.search(r"(\d+(?:\.\d+)?)\s*$", raw)
            if match:
                bpm = float(match.group(1))
        elif raw.startswith("M:"):
            try:
                num, den = map(int, raw[2:].strip().split("/", 1))
            except Exception:
                pass
    bar_sec = (num * (4.0 / den) * 60.0) / max(bpm, 1e-6)
    voice = ""
    current = "intro"
    vocal_bars = 0
    chunks: list[tuple[str, int]] = []

    def flush():
        nonlocal vocal_bars, current
        chunks.append((current, vocal_bars))
        vocal_bars = 0

    for raw in (text or "").splitlines():
        line = raw.strip()
        if line.startswith("%"):
            label = re.sub(r"^%+", "", line).strip()
            label = re.split(r"[^A-Za-z]+", label)[0].lower() if label else "verse"
            if vocal_bars or chunks:
                flush()
            current = _canon_section(label)
            continue
        if line.startswith("V:"):
            voice = line[2:].strip().split()[0]
            continue
        if re.match(r"^[A-Za-z]:", line):
            continue
        if "vocal" in voice.lower() or (not voice and "ins" not in voice.lower()):
            vocal_bars += line.count("|")
    if vocal_bars or not chunks:
        flush()
    t = 0.0
    spans: list[tuple[float, float, str]] = []
    for name, bars in chunks:
        if bars <= 0:
            continue
        start, end = t, t + bars * bar_sec
        t = end
        spans.append((start, end, name))
    if spans:
        print(f"[SongLRC] ABC structure: {len(spans)} sections, score~{t:.1f}s bpm={bpm:g}")
    return spans


def parse_structure_spans(text: str, duration: float) -> list[tuple[float, float, str]]:
    abc_spans = parse_abc_structure(text, duration)
    if abc_spans:
        return abc_spans
    spans: list[tuple[float, float, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = re.split(r"\t+", line)
        if len(parts) >= 3:
            try:
                spans.append((float(parts[0]), float(parts[1]), _canon_section(parts[2])))
                continue
            except ValueError:
                pass
        m = re.match(r"^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*:\s*(.+)$", line)
        if m:
            spans.append((float(m.group(1)), float(m.group(2)), _canon_section(m.group(3))))
    merged: list[tuple[float, float, str]] = []
    for start, end, name in sorted(spans):
        if merged and merged[-1][2] == name and abs(merged[-1][1] - start) < 0.05:
            merged[-1] = (merged[-1][0], end, name)
        else:
            merged.append((start, min(end, duration), name))
    return merged


def line_windows(lyrics: str, seconds: float, structure: str = "",
                 offset: float = 0.0, scale: float = 1.0) -> list[tuple[str, float, float]]:
    """Per-line [start, end) windows. Uses SheetSage2 structure when present.

    Without structure, skip a short intro/outro so lyrics are not jammed into
    the first second of a YuE2 song (vocals typically enter ~6% in).
    """
    seconds = max(float(seconds), 1.0)
    scale = max(float(scale), 0.5)
    offset = float(offset)
    blocks = parse_lyric_blocks(lyrics)
    if not blocks:
        return []

    notes, _bpm, score_end = vocal_note_spans(structure) if structure else ([], 120.0, 0.0)
    abc_spans = parse_abc_structure(structure, 1e9) if structure else []
    if abc_spans:
        fit = _fit_tempo(max(score_end, abc_spans[-1][1]), seconds)
        spans = []
        for a, b, n in abc_spans:
            a, b = a * fit, b * fit
            if a >= seconds:
                break
            spans.append((a, min(b, seconds), n))
        notes = [(a * fit, b * fit, sec) for a, b, sec in notes]
        print(f"[SongLRC] tempo fit={fit:.3f} (score {max(score_end, abc_spans[-1][1]):.1f}s -> audio {seconds:.1f}s), "
              f"vocal notes={len(notes)}")
    else:
        spans = parse_structure_spans(structure, seconds)
        fit = 1.0
    assigned: list[tuple[str, list[str], float, float]] = []
    if spans:
        unused = list(spans)
        for name, lines in blocks:
            match_i = next((i for i, (_s, _e, n) in enumerate(unused) if n == name), None)
            if match_i is None and name == "bridge":
                match_i = next((i for i, (_s, _e, n) in enumerate(unused) if n == "verse"), None)
            if match_i is None:
                match_i = next((i for i, (_s, _e, n) in enumerate(unused)
                                if n not in _NON_SINGING), None)
            if match_i is None:
                continue
            start, end, _n = unused.pop(match_i)
            assigned.append((name, lines, start, end))
        used_ids = {id(lines) for _n, lines, _s, _e in assigned}
        leftover = [(n, l) for n, l in blocks if id(l) not in used_ids]
        leftover_spans = [u for u in unused if u[2] not in _NON_SINGING]
        if leftover and leftover_spans:
            rest_start = leftover_spans[0][0]
            rest_end = leftover_spans[-1][1]
            rest_lines = [line for _n, lines in leftover for line in lines]
            if rest_lines:
                assigned.append(("verse", rest_lines, rest_start, rest_end))
        elif leftover and assigned:
            # Score was truncated (max_duration). Park extra lines in leftover
            # audio after the last matched section — never in the intro.
            last_end = assigned[-1][3]
            rest_lines = [line for _n, lines in leftover for line in lines]
            if rest_lines and last_end < seconds - 1.0:
                assigned.append((leftover[0][0], rest_lines, last_end, seconds))
            else:
                print("[SongLRC] Dropping extra lyric sections past the audio end")
    else:
        # Do not invent a 6% intro delay: score-editor songs often start
        # singing in the first bars, and a pad makes the LRC lag the vocal.
        start = 0.0
        end = max(start + 1.0, seconds * (1.0 - 0.04))
        lines = [line for _n, block in blocks for line in block]
        assigned.append(("verse", lines, start, end))

    windows: list[tuple[str, float, float]] = []
    for name, lines, start, end in assigned:
        start = max(0.0, start * scale + offset)
        end = max(start + 0.25, min(seconds, end * scale + offset))
        # Even spread inside the section is only a prior for WhisperX.
        # Tight ABC-note phrasing drifted because YuE2 does not sing the
        # written onsets. WhisperX retimes against the actual audio.
        step = (end - start) / max(len(lines), 1)
        for i, line in enumerate(lines):
            windows.append((line, start + step * i, start + step * (i + 1)))
    return windows


def format_lrc(windows: list[tuple[str, float, float]], seconds: float,
               title: str, artist: str, byline: str) -> str:
    header = [f"[ti:{title}]"]
    if str(artist or "").strip():
        header.append(f"[ar:{artist}]")
    header += [
        f"[length:{int(seconds // 60):02d}:{seconds % 60:05.2f}]",
        f"[by:{byline}]",
        "",
    ]
    body = []
    for text, start, _end in windows:
        mm = int(start // 60)
        ss = start % 60
        body.append(f"[{mm:02d}:{ss:05.2f}]{text}")
    return "\n".join(header + body) + "\n"


def _word_tokens(text: str) -> list[str]:
    # Keep non-English lyrics usable while normalizing curly apostrophes.
    text = unicodedata.normalize("NFKC", str(text or "")).casefold()
    text = text.replace("’", "'").replace("‘", "'")
    return re.findall(r"[^\W_]+(?:'[^\W_]+)*", text, re.UNICODE)


def _line_evidence(result: dict, lines: list[str]) -> list[tuple[float | None, float | None, int]]:
    """Map WhisperX words back to lyric lines without losing untimed words.

    WhisperX returns the supplied words in order, but some have no timestamp.
    Skipping those words shifts every later line in a count-based/greedy mapper.
    """
    expected = []
    owners = []
    for i, line in enumerate(lines):
        tokens = _word_tokens(line)
        expected.extend(tokens)
        owners.extend([i] * len(tokens))

    observed = []
    timed = []
    for segment in result.get("segments") or []:
        for word in segment.get("words") or []:
            tokens = _word_tokens(word.get("word", ""))
            for token in tokens:
                observed.append(token)
                timed.append(word)

    starts = [None] * len(lines)
    ends = [None] * len(lines)
    counts = [0] * len(lines)
    for block in SequenceMatcher(None, expected, observed, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            owner = owners[block.a + k]
            word = timed[block.b + k]
            if word.get("start") is None:
                continue
            start = float(word["start"])
            end = float(word.get("end") or start)
            starts[owner] = start if starts[owner] is None else min(starts[owner], start)
            ends[owner] = end if ends[owner] is None else max(ends[owner], end)
            counts[owner] += 1
    return list(zip(starts, ends, counts))


def _collapsed_run(starts: list[float | None], lines: list[str]) -> int | None:
    """Find the first implausibly compressed group of lyric lines."""
    for i in range(len(starts) - 3):
        gaps = []
        for j in range(i, i + 3):
            if starts[j] is None or starts[j + 1] is None:
                break
            min_gap = max(0.28, min(0.65, 0.065 * len(_word_tokens(lines[j]))))
            gaps.append(starts[j + 1] - starts[j] < min_gap)
        if len(gaps) == 3 and all(gaps):
            return i
    return None


_MIN_LINE_GAP = 0.08


def _estimated_line_seconds(line: str) -> float:
    """Rough sung length for a line that forced alignment could not time."""
    tokens = max(1, len(_word_tokens(line)))
    return min(4.0, max(0.9, 0.45 * tokens))


def _fill_missing_times(lines: list[str], evidence: list[tuple[float | None, float | None, int]],
                        seconds: float, scale: float, offset: float) -> list[tuple[float, float]]:
    """Give every line a window, interpolating the ones WhisperX left untimed.

    Dropping an untimed line silently deletes a real lyric. The usual
    casualties are the short ad-libs at the very end of a song, where forced
    alignment is weakest and a missing line is most obvious to the listener.
    """
    timed: list[tuple[float, float] | None] = []
    for start, end, count in evidence:
        if start is None or count == 0:
            timed.append(None)
            continue
        line_start = max(0.0, min(seconds, start * scale + offset))
        line_end = max(line_start,
                       min(seconds, (end if end is not None else start) * scale + offset))
        timed.append((line_start, line_end))
    if not any(item is not None for item in timed):
        return []

    index = 0
    while index < len(timed):
        if timed[index] is not None:
            index += 1
            continue
        stop = index
        while stop < len(timed) and timed[stop] is None:
            stop += 1
        run = range(index, stop)
        before = timed[index - 1] if index else None
        after = timed[stop] if stop < len(timed) else None
        if before and after:
            step = (after[0] - before[1]) / (len(run) + 1)
            for position, target in enumerate(run, start=1):
                point = before[1] + step * position
                length = min(max(step * 0.8, 0.0), _estimated_line_seconds(lines[target]))
                timed[target] = (point, min(seconds, point + length))
        elif before:
            cursor = before[1]
            for target in run:
                cursor = min(seconds, cursor + _MIN_LINE_GAP * 4)
                length = _estimated_line_seconds(lines[target])
                timed[target] = (cursor, min(seconds, cursor + length))
                cursor = min(seconds, cursor + length)
        else:
            cursor = after[0]
            for target in reversed(run):
                length = _estimated_line_seconds(lines[target])
                point = max(0.0, cursor - length)
                timed[target] = (point, cursor)
                cursor = max(0.0, point - _MIN_LINE_GAP * 4)
        index = stop
    filled = [item for item in timed if item is not None]
    return filled if len(filled) == len(evidence) else []


def _lrc_from_evidence(lines: list[str], evidence: list[tuple[float | None, float | None, int]],
                       seconds: float, title: str, artist: str, offset: float,
                       scale: float = 1.0) -> str:
    header = [f"[ti:{title}]"]
    if str(artist or "").strip():
        header.append(f"[ar:{artist}]")
    header += [f"[length:{int(seconds // 60):02d}:{seconds % 60:05.2f}]",
               "[by:SongLRC + whisperx audio-align]", ""]
    windows = _fill_missing_times(lines, evidence, seconds, scale, offset)
    if not windows:
        return ""
    entries: list[tuple[str, float, float]] = []
    for line, (start, end) in zip(lines, windows):
        # Nudge a colliding timestamp forward instead of dropping the line.
        # Two short closing ad-libs often share a single forced-alignment
        # time, and skipping the second silently loses a real lyric.
        if entries and start <= entries[-1][1]:
            start = min(seconds, entries[-1][1] + _MIN_LINE_GAP)
        entries.append((line, start, max(start, min(seconds, end))))
    for i, (line, start, end) in enumerate(entries):
        header.append(f"[{int(start // 60):02d}:{start % 60:05.2f}]{line}")
        next_start = entries[i + 1][1] if i + 1 < len(entries) else seconds
        # The bundled MusicPlayer accepts empty LRC entries; clear a line
        # during a long instrumental break instead of leaving it "stuck".
        if next_start - end > 5.0:
            clear_at = min(end + 1.5, next_start - 1.0)
            if clear_at > start + 0.1:
                header.append(f"[{int(clear_at // 60):02d}:{clear_at % 60:05.2f}]")
    return "\n".join(header) + "\n"


class SongLyricsToLRC:
    """
    Lyrics + duration → LRC

    Modes:
    1. Even timing (always available)
    2. Forced alignment via whisperx when AUDIO is connected
       - Uses per-line segments for tighter mapping to original lyrics
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "lyrics": ("STRING", {
                    "multiline": True,
                    "default": ""
                }),
                "seconds": ("FLOAT", {
                    "default": 120.0,
                    "min": 0.0,
                    "max": 600.0,
                    "step": 0.1,
                    "tooltip": "Ignored when AUDIO is connected; duration is read from the audio."
                }),
            },
            "optional": {
                "audio": ("AUDIO",),
                "structure": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "SheetSage2 structure (start<TAB>end<TAB>section) OR a YuE2 ABC score with % intro/% verse/% chorus. Times lyrics to the score instead of spreading them from t=0."
                }),
                "title": ("STRING", {"default": "Generated Song"}),
                "artist": ("STRING", {"default": "", "tooltip": "Optional. Written as the LRC ar: tag."}),
                "language": ("STRING", {"default": "en"}),
                "offset_seconds": ("FLOAT", {
                    "default": 0.0,
                    "min": -30.0,
                    "max": 30.0,
                    "step": 0.1
                }),
                "timing_scale": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.7,
                    "max": 1.4,
                    "step": 0.01,
                    "tooltip": "Stretch timestamps if lyrics feel early/fast (>1) or late/slow (<1)."
                }),
                "prefer_alignment": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("lrc",)
    FUNCTION = "make_lrc"
    CATEGORY = "audio/SongLRC"
    OUTPUT_NODE = False

    def _even_lrc(self, lyrics: str, seconds: float, title: str, artist: str,
                  offset: float, structure: str = "", scale: float = 1.0):
        windows = line_windows(lyrics, seconds, structure=structure,
                               offset=offset, scale=scale)
        if not windows:
            return ""
        by = "SongLRC section-timing" if structure else "SongLRC padded even-timing"
        return format_lrc(windows, seconds, title, artist, by)

    def _audio_to_temp_wav(self, audio):
        try:
            waveform = audio["waveform"]
            sample_rate = audio["sample_rate"]

            if hasattr(waveform, "cpu"):
                waveform = waveform.cpu().numpy()
            waveform = np.asarray(waveform)

            if waveform.ndim == 3:
                waveform = waveform[0]
            if waveform.ndim == 2:
                waveform = waveform.mean(axis=0)

            waveform = waveform.astype(np.float32)
            peak = np.max(np.abs(waveform)) + 1e-8
            waveform = waveform / peak * 0.95

            import soundfile as sf
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            sf.write(tmp.name, waveform, sample_rate)
            return tmp.name
        except Exception as e:
            print(f"[SongLRC] Could not convert AUDIO to wav: {e}")
            return None

    def _get_display_lines(self, lyrics: str):
        """Return only real lyric lines (skip pure [Section] tags)."""
        lines = []
        for line in lyrics.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            if re.match(r"^\[.*\]$", line):
                continue
            lines.append(line)
        return lines

    def _align_with_whisperx(self, audio_path: str, lyrics: str, language: str, offset: float,
                             title: str, artist: str, seconds: float,
                             structure: str = "", scale: float = 1.0):
        try:
            import whisperx
            import torch

            if not isinstance(language, str) or len(language) < 2 or language.lower() in ("true", "false"):
                print(f"[SongLRC] Invalid language value '{language}', forcing 'en'")
                language = "en"

            device = "cuda" if torch.cuda.is_available() else "cpu"
            windows = line_windows(lyrics, seconds, structure=structure)
            display_lines = [w[0] for w in windows] or self._get_display_lines(lyrics)
            if not display_lines:
                return None

            n = len(display_lines)
            sing_start = windows[0][1] if windows else 0.0
            sing_end = windows[-1][2] if windows else seconds
            # First vocal note is a better left edge than even-section guesses.
            notes, _bpm, _end = vocal_note_spans(structure) if structure else ([], 120.0, 0.0)
            if notes:
                fit = _fit_tempo(notes[-1][1], seconds)
                first_v = notes[0][0] * fit
                last_v = notes[-1][1] * fit
                if 0.0 <= first_v < seconds:
                    sing_start = min(sing_start, first_v)
                if last_v > sing_start:
                    sing_end = min(seconds, max(sing_end, last_v))
            sing_start = max(0.0, sing_start - 0.4)
            sing_end = min(seconds, max(sing_end + 0.8, sing_start + 1.0))

            audio = whisperx.load_audio(audio_path)
            model_a, metadata = whisperx.load_align_model(
                language_code=language, device=device
            )

            def run_align(segments, label):
                print(f"[SongLRC] WhisperX {label} on {device} ({n} lines, "
                      f"sing {sing_start:.1f}-{sing_end:.1f}s)")
                return whisperx.align(
                    segments, model_a, metadata, audio, device,
                    return_char_alignments=False,
                )

            # Align the exact supplied transcript once, then inspect the
            # evidence for every line. Forced alignment can assign an entire
            # unsung suffix to the final second when the render is truncated.
            joined = " ".join(display_lines)
            result = run_align([{
                "start": sing_start,
                "end": sing_end,
                "text": joined,
            }], "full-span")
            evidence = _line_evidence(result, display_lines)
            starts = [entry[0] for entry in evidence]
            collapse = _collapsed_run(starts, display_lines)
            observed = sum(start is not None for start in starts)
            reversed_time = any(starts[i] is not None and starts[i - 1] is not None
                                and starts[i] <= starts[i - 1]
                                for i in range(1, len(starts)))
            trimmed = False

            if collapse is not None and starts[collapse] is not None and starts[collapse] > seconds - 18:
                # There is no credible room for the remaining lines. This is
                # typical when max_duration cut off a YuE2 composition.
                print(f"[SongLRC] Omitting {n - collapse} unsung/truncated lines "
                      f"compressed at {starts[collapse]:.1f}s")
                display_lines = display_lines[:collapse]
                evidence = evidence[:collapse]
                trimmed = True
            elif collapse is not None or reversed_time or observed < len(display_lines):
                print("[SongLRC] Full-span timing unreliable; retrying bounded line windows")
                interval = (sing_end - sing_start) / max(n, 1)
                pad = max(2.2, interval * 0.8)
                segs = []
                for i, line in enumerate(display_lines):
                    center = sing_start + interval * (i + 0.5)
                    segs.append({
                        "start": max(sing_start, center - pad),
                        "end": min(sing_end, center + pad),
                        "text": line,
                    })
                result = run_align(segs, "wide-window")
                aligned = result.get("segments") or []
                retried = []
                for i, line in enumerate(display_lines):
                    item = _line_evidence({"segments": [aligned[i]]}, [line])[0] if i < len(aligned) else (None, None, 0)
                    retried.append(item)
                evidence = retried

            if not display_lines or not any(item[0] is not None for item in evidence):
                return None
            starts = [item[0] for item in evidence]
            if (_collapsed_run(starts, display_lines) is not None
                    or any(starts[i] is not None and starts[i - 1] is not None
                           and starts[i] <= starts[i - 1]
                           for i in range(1, len(starts)))
                    or (not trimmed and sum(t is not None for t in starts) < 0.85 * len(starts))):
                print("[SongLRC] Alignment still unreliable; using complete timing fallback")
                return None
            lrc = _lrc_from_evidence(display_lines, evidence, seconds, title, artist,
                                     offset, scale)
            if not lrc:
                print("[SongLRC] Alignment produced no usable lines; using fallback")
                return None
            # Count what was actually written. Counting evidence instead
            # reported success for lines the writer had dropped.
            written = sum(1 for row in lrc.splitlines()
                          if row.startswith("[") and "]" in row
                          and row.split("]", 1)[1].strip())
            guessed = sum(1 for item in evidence if item[0] is None or item[2] == 0)
            detail = f", {guessed} interpolated" if guessed else ""
            print(f"[SongLRC] audio-align succeeded ({written}/{n} lines written{detail})")
            return lrc

        except ImportError:
            print("[SongLRC] whisperx not installed")
            return None
        except Exception as e:
            print(f"[SongLRC] whisperx alignment failed: {e}")
            return None

    def _audio_seconds(self, audio):
        waveform = audio["waveform"]
        sample_rate = int(audio.get("sample_rate") or 0)
        if hasattr(waveform, "detach"):
            waveform = waveform.detach().cpu()
        if hasattr(waveform, "numpy"):
            waveform = waveform.numpy()
        waveform = np.asarray(waveform)
        samples = waveform.shape[-1] if waveform.ndim else 0
        if sample_rate <= 0 or samples <= 0:
            raise ValueError("AUDIO has no duration")
        return float(samples) / float(sample_rate)

    def make_lrc(self, lyrics, seconds, audio=None, structure="", title="Generated Song",
                 artist="", language="en",
                 offset_seconds=0.0, timing_scale=1.0, prefer_alignment=True, **kwargs):

        # Defensive: ComfyUI sometimes shuffles optional args
        if not isinstance(language, str) or language.lower() in ("true", "false") or len(str(language)) < 2:
            if isinstance(prefer_alignment, str) and len(prefer_alignment) >= 2:
                language, prefer_alignment = prefer_alignment, language
            else:
                language = "en"

        if not isinstance(prefer_alignment, bool):
            prefer_alignment = True

        if not lyrics or not str(lyrics).strip():
            return ("",)

        cleaned, extracted_title = sanitize_generated_lyrics(str(lyrics))
        if cleaned:
            lyrics = cleaned
            print(f"[SongLRC] Sanitized Qwen/markdown lyrics ({len(cleaned.splitlines())} lines)")
        if extracted_title and (not title or title in ("", "Generated Song")):
            title = extracted_title

        seconds = float(seconds)
        offset_seconds = float(offset_seconds)
        if audio is not None:
            try:
                seconds = self._audio_seconds(audio)
                print(f"[SongLRC] Using AUDIO duration {seconds:.2f}s")
            except Exception as e:
                print(f"[SongLRC] Could not read AUDIO duration ({e}); using seconds={seconds}")

        if prefer_alignment and audio is not None:
            wav_path = self._audio_to_temp_wav(audio)
            if wav_path:
                try:
                    aligned = self._align_with_whisperx(
                        wav_path, str(lyrics), language, offset_seconds,
                        title, artist, seconds,
                        structure=structure or "",
                        scale=float(timing_scale or 1.0),
                    )
                    if aligned:
                        return (aligned,)
                finally:
                    try:
                        os.unlink(wav_path)
                    except Exception:
                        pass

        print("[SongLRC] Using section/padded even-timing")
        return (self._even_lrc(str(lyrics), seconds, title, artist, offset_seconds,
                               structure=structure or "", scale=float(timing_scale or 1.0)),)


class SongLyricsClean:
    """Strip titles and markdown so the song model and the LRC get only lyrics."""

    DESCRIPTION = (
        "Drops Title, subtitle and markdown from generated or pasted lyrics, "
        "normalizes [VERSE 1 - x2] to [verse], keeps only section tags and lyric lines."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"text": ("STRING", {
            "multiline": True,
            "default": "",
            "tooltip": "Paste lyrics here, or connect a text generator.",
        })}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("lyrics", "title")
    FUNCTION = "clean"
    CATEGORY = "audio/SongLRC"

    def clean(self, text):
        lyrics, title = sanitize_generated_lyrics(text or "")
        if not title:
            title = derive_song_title(lyrics)
            print(f"[SongLRC] Lyrics model omitted title; derived {title!r} from the hook")
        print(f"[SongLRC] Cleaned lyrics: {len(lyrics.splitlines())} lines, title={title!r}")
        return (lyrics, title)


def safe_song_title(title: str) -> str:
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", str(title or ""))
    title = re.sub(r"\s+", " ", title).strip(" .-_")
    return title[:80].rstrip() or "Generated Song"


class SongFilename:
    """Build one safe title and the output prefix used by the core audio saver."""

    CATEGORY = "audio/SongLRC"
    FUNCTION = "prepare"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("filename_prefix", "safe_title")
    DESCRIPTION = "Turn a song title into <folder>/<title> for Save Audio (Advanced)."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "title": ("STRING", {
                    "default": "",
                    "tooltip": "Leave blank to derive a title from the lyrics.",
                }),
                "folder": ("STRING", {
                    "default": "audio/songs",
                    "tooltip": "Subfolder inside ComfyUI's output directory.",
                }),
            },
            "optional": {
                "lyrics": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Used to derive a title when the title field is blank.",
                }),
            },
        }

    def prepare(self, title, folder="audio/songs", lyrics=""):
        # Hand written lyrics rarely carry a Title: line, so fall back to the
        # repeated hook rather than naming every song "Generated Song".
        if not str(title or "").strip() and str(lyrics or "").strip():
            cleaned, extracted = sanitize_generated_lyrics(str(lyrics))
            title = extracted or derive_song_title(cleaned)
        name = safe_song_title(title)
        prefix = str(folder or "").replace("\\", "/").strip("/") or "audio/songs"
        return (f"{prefix}/{name}", name)


class SongSaveMatchingLRC:
    """Write an LRC beside the audio file just produced by SaveAudioAdvanced."""

    CATEGORY = "audio/SongLRC"
    FUNCTION = "save"
    OUTPUT_NODE = True
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    DESCRIPTION = "Save the LRC with the exact title and counter of the latest matching FLAC, MP3, or Opus file."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "lrc": ("STRING", {"forceInput": True}),
            "filename_prefix": ("STRING", {"forceInput": True}),
        }}

    def save(self, audio, lrc, filename_prefix):
        import folder_paths

        output_root = os.path.abspath(folder_paths.get_output_directory())
        normalized = str(filename_prefix or "").replace("\\", "/").strip("/")
        subfolder, filename = os.path.split(normalized)
        filename = safe_song_title(filename)
        output_dir = os.path.abspath(os.path.join(output_root, subfolder))
        if os.path.commonpath([output_root, output_dir]) != output_root:
            raise ValueError("LRC output must stay inside the ComfyUI output directory")

        os.makedirs(output_dir, exist_ok=True)
        pattern = re.compile(
            rf"^{re.escape(filename)}_(\d{{5}})\.(?:flac|mp3|opus)$",
            re.IGNORECASE,
        )
        matches = [
            (int(match.group(1)), name)
            for name in os.listdir(output_dir)
            if (match := pattern.match(name))
        ]
        if not matches:
            raise FileNotFoundError(
                f"No saved FLAC, MP3, or Opus found for filename prefix {normalized!r}"
            )

        _, audio_name = max(matches, key=lambda item: item[0])
        lrc_name = f"{os.path.splitext(audio_name)[0]}.lrc"
        lrc_full_path = os.path.join(output_dir, lrc_name)
        with open(lrc_full_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(str(lrc))

        lrc_path = os.path.join(subfolder, lrc_name).replace("\\", "/")
        print(f"[SongLRC] Saved matching LRC: {lrc_path}")
        return {
            "ui": {"text": [str(lrc)], "saved": [lrc_path]},
            "result": (audio,),
        }


class SongSaveLRC:
    """Write the LRC on its own, without waiting for an audio file."""

    CATEGORY = "audio/SongLRC"
    FUNCTION = "save"
    OUTPUT_NODE = True
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    DESCRIPTION = "Save the LRC to the output folder with its own counter."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "lrc": ("STRING", {"forceInput": True}),
            "filename_prefix": ("STRING", {
                "default": "audio/songs/lyrics",
                "tooltip": "Path inside the output folder. Connect Song Filename to match the audio name.",
            }),
        }}

    def save(self, lrc, filename_prefix="audio/songs/lyrics"):
        import folder_paths

        output_root = os.path.abspath(folder_paths.get_output_directory())
        normalized = str(filename_prefix or "").replace("\\", "/").strip("/")
        subfolder, filename = os.path.split(normalized)
        filename = safe_song_title(filename)
        output_dir = os.path.abspath(os.path.join(output_root, subfolder))
        if os.path.commonpath([output_root, output_dir]) != output_root:
            raise ValueError("LRC output must stay inside the ComfyUI output directory")
        os.makedirs(output_dir, exist_ok=True)

        pattern = re.compile(rf"^{re.escape(filename)}_(\d{{5}})[.]lrc$", re.IGNORECASE)
        used = [int(match.group(1)) for name in os.listdir(output_dir)
                for match in [pattern.match(name)] if match]
        counter = max(used) + 1 if used else 1
        name = f"{filename}_{counter:05d}.lrc"
        with open(os.path.join(output_dir, name), "w", encoding="utf-8",
                  newline="\n") as handle:
            handle.write(str(lrc))

        relative = os.path.join(subfolder, name).replace("\\", "/")
        # Show the timed lyrics on the node, not just where they went.
        print(f"[SongLRC] Saved LRC: {relative}")
        return {"ui": {"text": [str(lrc)], "saved": [relative]}, "result": (relative,)}


class SongMusicPlayer:
    """Play the song with its own lyrics scrolling in time."""

    CATEGORY = "audio/SongLRC"
    FUNCTION = "play"
    OUTPUT_NODE = True
    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    DESCRIPTION = "Play the audio with its LRC highlighted line by line."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "audio": ("AUDIO",),
            "lrc": ("STRING", {"forceInput": True}),
        }}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always hand the browser a fresh file; the player is a view, not a cache.
        return float("nan")

    def play(self, audio, lrc):
        import uuid

        import folder_paths
        import soundfile as sf

        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        name = "songlrc_" + uuid.uuid4().hex + ".flac"

        samples = audio["waveform"]
        if hasattr(samples, "detach"):
            samples = samples.detach().cpu()
        if hasattr(samples, "numpy"):
            samples = samples.numpy()
        samples = np.asarray(samples, dtype=np.float32)
        if samples.ndim == 3:
            samples = samples[0]
        if samples.ndim == 1:
            samples = samples[None, :]
        # soundfile wants frames first, channels second.
        sf.write(os.path.join(temp_dir, name),
                 np.clip(samples, -1.0, 1.0).transpose(),
                 int(audio.get("sample_rate") or 44100), format="FLAC")

        return {
            "ui": {
                "audio": [{"filename": name, "subfolder": "", "type": "temp"}],
                "lrc": [str(lrc)],
            },
            "result": (audio,),
        }


NODE_CLASS_MAPPINGS = {
    "SongLyricsToLRC": SongLyricsToLRC,
    "SongLyricsClean": SongLyricsClean,
    "SongFilename": SongFilename,
    "SongSaveMatchingLRC": SongSaveMatchingLRC,
    "SongSaveLRC": SongSaveLRC,
    "SongMusicPlayer": SongMusicPlayer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SongLyricsToLRC": "Lyrics to LRC",
    "SongLyricsClean": "Lyrics Clean",
    "SongFilename": "Song Filename",
    "SongSaveMatchingLRC": "Save Matching LRC",
    "SongSaveLRC": "Save LRC (auto)",
    "SongMusicPlayer": "Music Player (SongLRC)",
}

_LEGACY_NAMES = (
    ("MiniMaxLyricsToLRC", "SongLyricsToLRC"),
    ("MiniMaxLyricsClean", "SongLyricsClean"),
    ("MiniMaxSongFilename", "SongFilename"),
    ("MiniMaxSaveMatchingLRC", "SongSaveMatchingLRC"),
)


def _register_legacy_aliases():
    """Keep graphs saved as ComfyUI-MiniMaxLRC loading after the rename.

    A workflow stores the class key, so dropping the old keys would turn every
    existing song graph into red missing nodes. DEPRECATED keeps the aliases
    out of the node menu while they still resolve.
    """
    for old, new in _LEGACY_NAMES:
        base = NODE_CLASS_MAPPINGS[new]
        NODE_CLASS_MAPPINGS[old] = type(old, (base,), {"DEPRECATED": True})
        NODE_DISPLAY_NAME_MAPPINGS[old] = NODE_DISPLAY_NAME_MAPPINGS[new] + " (legacy)"


_register_legacy_aliases()
