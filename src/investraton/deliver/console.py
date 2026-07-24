"""Console delivery — prints the digest narrative to stdout."""

from __future__ import annotations

from ..models import Digest


def send(digest: Digest, settings) -> None:  # noqa: ARG001
    print("\n" + "=" * 70)
    print(digest.narrative)
    print("=" * 70 + "\n")
