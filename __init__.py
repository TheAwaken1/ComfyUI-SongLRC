from .song_lrc_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    from . import routes  # noqa: F401  (the player's lyric video export)
except Exception as error:  # the nodes still work; Export falls back to a plain download
    print(f"[SongLRC] video export route unavailable: {error}")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
