"""Config file: one YAML file lists every channel link and group export.

Example (``channels.yaml``)::

    # Channels: public t.me links. Live-scraped from the public preview.
    channels:
      - https://t.me/durov
      - t.me/telegram
    # Groups: public groups cannot be live-scraped (no preview), so each
    # group is indexed from a Telegram Desktop JSON export (see README).
    groups:
      - name: "Old Arabic Books"
        export: ~/exports/old-arabic-books/result.json
    settings:
      db: index.db
      delay_seconds: 1.5   # polite pause between preview pages
      limit_per_channel: 0  # 0 = walk until the preview stops serving posts

Adding a channel or a group needs no code change — add a line here and
run ``tbi index`` again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .scrape import normalize_link


@dataclass
class ChannelEntry:
    link: str
    username: str
    label: str = ""


@dataclass
class GroupEntry:
    name: str
    export: str
    label: str = ""


@dataclass
class Settings:
    db: str = "index.db"
    delay_seconds: float = 1.5
    limit_per_channel: int = 0  # 0 = unlimited walk


@dataclass
class Config:
    channels: list[ChannelEntry] = field(default_factory=list)
    groups: list[GroupEntry] = field(default_factory=list)
    settings: Settings = field(default_factory=Settings)
    path: str = ""


def load_config(path: str | Path) -> Config:
    path = Path(path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"Config file not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a YAML mapping at the top level")
    cfg = Config(path=str(path))
    for item in data.get("channels") or []:
        link = item if isinstance(item, str) else str(item.get("link", ""))
        label = "" if isinstance(item, str) else str(item.get("label", ""))
        username = normalize_link(link)
        if username:
            cfg.channels.append(
                ChannelEntry(link=link, username=username, label=label)
            )
    for item in data.get("groups") or []:
        if isinstance(item, dict):
            cfg.groups.append(
                GroupEntry(
                    name=str(item.get("name", "")),
                    export=str(item.get("export", "")),
                    label=str(item.get("label", "")),
                )
            )
        elif isinstance(item, str):
            cfg.groups.append(GroupEntry(name=item, export=item))
    raw_settings: dict[str, Any] = data.get("settings") or {}
    cfg.settings = Settings(
        db=str(raw_settings.get("db", "index.db")),
        delay_seconds=float(raw_settings.get("delay_seconds", 1.5)),
        limit_per_channel=int(raw_settings.get("limit_per_channel", 0)),
    )
    return cfg
