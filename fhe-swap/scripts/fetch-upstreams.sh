#!/usr/bin/env bash
# Fetch reference upstreams for study. This script does NOT vendor upstream code
# into fhe-swap and does not change the license of this repository.
#
# Canonical THORChain is GitLab. Some sandboxes cannot reach gitlab.com; in that
# case we fetch the deprecated GitHub mirror (README-only) and a public GitHub
# source fork, and label them explicitly. The fork is NOT canonical upstream.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-"$ROOT/../.cache/upstreams"}"
mkdir -p "$DEST"

clone_or_update() {
  local url="$1" dir="$2"
  if [ -d "$DEST/$dir/.git" ]; then
    echo "== update $dir"
    git -C "$DEST/$dir" fetch --depth 1 origin
    git -C "$DEST/$dir" reset --hard FETCH_HEAD
  else
    echo "== clone $dir"
    git clone --depth 1 "$url" "$DEST/$dir"
  fi
  git -C "$DEST/$dir" log -1 --format='%H %cs %s'
}

clone_or_update https://github.com/serai-dex/serai.git serai
clone_or_update https://github.com/monero-oxide/monero-oxide.git monero-oxide

if git ls-remote https://gitlab.com/thorchain/thornode.git HEAD >/dev/null 2>&1; then
  clone_or_update https://gitlab.com/thorchain/thornode.git thornode
else
  echo "WARN: gitlab.com/thorchain/thornode is unreachable from this environment." >&2
  echo "WARN: fetching GitHub mirror (README-only) and faddat/thornode source fork." >&2
  echo "WARN: faddat/thornode is a third-party fork, NOT canonical THORChain." >&2
  clone_or_update https://github.com/thorchain/thornode.git thornode-mirror
  clone_or_update https://github.com/faddat/thornode.git thornode-src-fork
fi

cat <<'EOF'

Reference links:
  Serai canonical:   https://github.com/serai-dex/serai
  monero-oxide:      https://github.com/monero-oxide/monero-oxide
  THORChain canonical: https://gitlab.com/thorchain/thornode
  THORChain GitHub mirror (deprecated, README-only):
                     https://github.com/thorchain/thornode
  THORChain source fork used only when GitLab is blocked:
                     https://github.com/faddat/thornode

Licenses:
  Serai is mixed-license per crate (MIT / AGPL-3.0-only; some dual files).
  monero-oxide / monero-clsag is MIT (inspect crate LICENSE before copying).
  THORChain thornode is MIT.
  This fhe-swap reference implementation is MIT and does not copy upstream code.
EOF
