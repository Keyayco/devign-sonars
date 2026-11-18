"""SONARS Source Adapters."""

from .base import CanonicalSignal, SourceAdapter
from .reddit import RedditAdapter

__all__ = ["CanonicalSignal", "SourceAdapter", "RedditAdapter"]
