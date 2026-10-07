#!/usr/bin/env bash
# Rebuilds test/fixtures bundles and ABI JSONs from the core tag in test/fixtures/CORE_REF.
# Needs git, a Rust toolchain with wasm32-unknown-unknown, and `cargo mero` on PATH.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ref=$(<"$root/test/fixtures/CORE_REF")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone -q --depth 1 --branch "$ref" https://github.com/calimero-network/core "$work/core"
for app in kv-store scaffolding-e2e; do
  (cd "$work/core/apps/$app" && CARGO_TARGET_DIR="$work/target" cargo mero bundle --dev --no-icon --no-logo -o "$work/$app.mpk")
  mkdir "$work/$app"
  tar xzf "$work/$app.mpk" -C "$work/$app"
  cp "$work/$app.mpk" "$root/test/fixtures/$app.mpk"
  cp "$work/$app/abi.json" "$root/test/fixtures/abi/$app.json"
done
