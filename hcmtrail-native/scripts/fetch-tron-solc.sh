#!/usr/bin/env bash
set -euo pipefail
: "${1:?Usage: bash scripts/fetch-tron-solc.sh /path/to/tron-solc}"
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'This compiler pin targets Linux x86-64.' >&2
  exit 1
fi
file=$(mktemp)
trap 'rm -f -- "$file"' EXIT
commit=b2e4c661d6df79c8f57b232d63ebfe7547cd3a84
asset=solc-linux-amd64-v0.8.24%2Bcommit.7d902c66
curl --fail --silent --show-error --max-time 60 --retry 2 -H 'Accept: application/vnd.github.raw+json' \
  "https://api.github.com/repos/tronprotocol/solc-bin/contents/linux-amd64/$asset?ref=$commit" -o "$file"
printf '%s  %s\n' 82605d2d64d9bcc2ab0b7608d192463de009a8ece6032058d4cbdbefbde87e78 "$file" | sha256sum -c -
install -m 0755 -- "$file" "$1"
