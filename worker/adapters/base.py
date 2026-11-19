"""
worker/adapters/base.py — Source Adapter Contract & Canonical Signal
====================================================================
Every intelligence source adapter implements SourceAdapter and emits
CanonicalSignal instances for uniform scoring, deduplication, and storage.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


OBSERVATION_TYPES = (
    "entity_discovered",
    "entity_verified",
    "digital_presence_gap",
    "contact_information_found",
    "buying_intent_signal",
)


@dataclass
class CanonicalSignal:
    source_type: str              # e.g. 'reddit', 'cipc', 'osm'
    source_entity_id: str         # globally unique key within source_type
    source_channel: str           # e.g. 'r/forhire', 'cipc-apiverse', 'osm-cape-town'
    entity_name: str              # poster handle or business/company name
    title: str                    # headline or entity display title
    content: str                  # sanitized body / evidence summary
    url: str                      # canonical source URL
    matched_keyword: str          # triggering keyword or discovery category/query
    published_utc: int            # Unix UTC timestamp of record or collection
    raw_payload: dict[str, Any] = field(default_factory=dict)
    observation_type: str = "buying_intent_signal"
    attribution: Optional[str] = None
    collected_utc: Optional[int] = None
    category: str = ""
    region: str = ""
    is_personal_info: bool = False
    contact_eligible: bool = False


LogFn = Callable[[str, str], None]


class SourceAdapter(ABC):
    def __init__(self, config: dict[str, Any], log_fn: Optional[LogFn] = None) -> None:
        self.config = config
        self._log = log_fn or (lambda _lvl, _msg: None)

    def log(self, level: str, msg: str) -> None:
        self._log(level, msg)

    @abstractmethod
    def get_source_type(self) -> str:
        """Unique adapter identifier."""

    @abstractmethod
    def poll(self, seen_ids: set[str]) -> tuple[list[CanonicalSignal], dict[str, int]]:
        """Poll source and return (new_signals, cycle_metrics)."""

    @abstractmethod
    def health_check(self) -> bool:
        """Verify adapter configuration readiness."""
