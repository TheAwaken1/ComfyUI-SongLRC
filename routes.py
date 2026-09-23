"""HTTP routes for the music player's lyric video export."""

import asyncio
import os

from aiohttp import web

import folder_paths
from server import PromptServer

from .song_lrc_node import append_video_part, encode_video, finalize_video


def _view_file(info):
    """Resolve a /view style {filename, subfolder, type} to a path inside ComfyUI's folders."""
    base = folder_paths.get_directory_by_type(str(info.get("type") or "output"))
    if not base:
        raise ValueError("Unknown audio folder")
    base = os.path.abspath(base)
    path = os.path.abspath(os.path.join(base, str(info.get("subfolder") or ""),
                                        str(info.get("filename") or "")))
    if os.path.commonpath([base, path]) != base or not os.path.isfile(path):
        raise ValueError("Audio file not found")
    return path


async def _in_thread(work):
    return await asyncio.get_running_loop().run_in_executor(None, work)


@PromptServer.instance.routes.post("/songlrc/video/part")
async def video_part(request):
    try:
        size = append_video_part(
            folder_paths.get_temp_directory(),
            request.query.get("id", ""),
            int(request.query.get("index", "0")),
            await request.read(),
        )
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"size": size})


@PromptServer.instance.routes.post("/songlrc/video/encode")
async def video_encode(request):
    """Frames rendered in the browser plus the song's audio -> MP4."""
    try:
        body = await request.json()
        audio = _view_file(body.get("audio") or {})
        subfolder, filename = await _in_thread(lambda: encode_video(
            folder_paths.get_temp_directory(),
            folder_paths.get_output_directory(),
            body.get("id", ""),
            body.get("title", ""),
            body.get("kind", ""),
            body.get("fps", 30),
            audio,
        ))
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"filename": filename, "subfolder": subfolder, "type": "output"})


@PromptServer.instance.routes.post("/songlrc/video/finish")
async def video_finish(request):
    """A finished real-time recording -> a regular video file."""
    try:
        body = await request.json()
        subfolder, filename = await _in_thread(lambda: finalize_video(
            folder_paths.get_temp_directory(),
            folder_paths.get_output_directory(),
            body.get("id", ""),
            body.get("title", ""),
            body.get("extension", ""),
        ))
    except Exception as error:
        return web.json_response({"error": str(error)}, status=400)
    return web.json_response({"filename": filename, "subfolder": subfolder, "type": "output"})
