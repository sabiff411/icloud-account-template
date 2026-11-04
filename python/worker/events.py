"""Event helpers.

The pyicloud work is synchronous and runs in a thread.  `Emitter` is the only
bridge back to the asyncio socket: it schedules `sio.emit` on the loop and
throttles progress so a 10k-photo export cannot flood Socket.IO.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from typing import Any, Callable


def json_safe(value: Any) -> Any:
    """Turn datetimes, Paths and model objects into plain JSON."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            return str(value)
    if hasattr(value, "__dict__"):
        return json_safe(vars(value))
    return str(value)


class Emitter:
    def __init__(self, loop: asyncio.AbstractEventLoop, emit: Callable[..., Any]):
        self.loop = loop
        self._emit = emit
        self._last: dict[tuple[str, str], float] = defaultdict(float)

    def send(self, event: str, payload: dict, *, key: str = "", throttle: float = 0.0) -> None:
        if key and throttle:
            now = time.monotonic()
            if now - self._last[(event, key)] < throttle:
                return
            self._last[(event, key)] = now
        data = json_safe(payload)
        try:
            asyncio.run_coroutine_threadsafe(self._emit(event, data), self.loop)
        except RuntimeError:
            pass

    def progress(self, payload: dict, *, area: str = "", throttle: float = 1.0) -> None:
        self.send("job:export_progress", payload, key=area or "overall", throttle=throttle)
