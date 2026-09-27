#!/usr/bin/env bash
# Finds the newest calimero-network/core release that actually ships the given
# asset. Core also publishes release candidates with no merod build attached,
# so picking the single newest tag (--limit 1) can point at a 404.
set -euo pipefail

REPO=calimero-network/core
ASSET="${1:-merod_x86_64-unknown-linux-gnu.tar.gz}"
LIMIT=20

for TAG in $(gh release list --repo "$REPO" --limit "$LIMIT" --json tagName --jq '.[].tagName'); do
  if gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name' | grep -qx "$ASSET"; then
    echo "$TAG"
    exit 0
  fi
done

echo "::error::no release in the last $LIMIT on $REPO ships asset '$ASSET'" >&2
exit 1
