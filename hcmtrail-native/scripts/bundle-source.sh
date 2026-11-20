#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
f=${1:-"$root/dist/hcmtrail-native-source.tar.gz"}
mkdir -p -- "$(dirname "$f")"
# Explicit source directories only; excludes parent repo, build artifacts, dependency trees and upstream checkouts.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$root" -czf "$f" \
  .gitignore README.md package.json package-lock.json contracts docs scripts test testnet
sha256sum "$f"
