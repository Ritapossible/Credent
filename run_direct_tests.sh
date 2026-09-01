#!/usr/bin/env bash
# Run the direct-mode contract tests.
#
# These execute `reputation_oracle.py` in-memory against GenLayer's own test
# harness — no node, no keys, no gas — and they are what covers the payout path
# end to end: a wallet refused at every step, `withdraw` parking the entitlement,
# and `reclaim` restoring it after a transfer that did not arrive. That last case
# cannot be produced on a live network, because every contract is credited.
#
# Two things they need that the default suite does not:
#
#   * Python 3.12 or newer. `genlayer-py` imports `collections.abc.Buffer`.
#   * A cached GenVM release tarball, which the harness downloads on first run
#     to ~/.cache/gltest-direct. Behind a proxy that Python's urllib will not
#     verify, fetch it once by hand:
#
#       curl -sSL -o ~/.cache/gltest-direct/genvm-universal-v0.2.16.tar.xz \
#         https://github.com/genlayerlabs/genvm/releases/download/v0.2.16/genvm-universal.tar.xz
#
# The default `python -m pytest` skips this directory when the harness is not
# importable, so a contributor without it still gets a green run.
set -euo pipefail

PYTHON="${DIRECT_TEST_PYTHON:-python3.13}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "need python 3.12+ — set DIRECT_TEST_PYTHON to one" >&2
  exit 1
fi

"$PYTHON" -c 'import gltest.direct.pytest_plugin' 2>/dev/null || {
  echo "installing genlayer-test for $PYTHON" >&2
  "$PYTHON" -m pip install --quiet genlayer-test
}

exec "$PYTHON" -m pytest tests/direct "$@"
