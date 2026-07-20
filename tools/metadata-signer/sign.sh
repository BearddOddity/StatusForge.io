#!/usr/bin/env bash
# Simple wrapper around the metadata-signer CLI so you never have to think
# about cargo build/run flags — just the two things you actually do:
#
#   ./sign.sh keygen
#       One-time setup. Makes a new keypair, prints the public key (paste
#       into src-tauri/src/metadata_signing.rs if you ever rotate it), and
#       writes the private key to ./signing_key.b64.
#
#   ./sign.sh entry.json signed_entry.json [path/to/signing_key.b64]
#       Signs entry.json (one game, or a whole database dump) using
#       ./signing_key.b64 (or the key file path given as the 3rd arg) and
#       writes the signed file ready to publish on bearddoddity.github.io.
#
# Safety: signing_key.b64 is gitignored and this script never prints its
# contents or uploads it anywhere. Still, it's the only thing that can
# forge a "Verified official" entry — keep your copy somewhere safe
# (password manager, offline backup) and don't paste it into chat/issues.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

KEY_FILE="signing_key.b64"

usage() {
  echo "Usage:"
  echo "  ./sign.sh keygen                                            — generate a new signing key (one-time)"
  echo "  ./sign.sh <entry.json> <signed_out.json> [key_file]         — sign a file (default key: $KEY_FILE)"
  exit 1
}

[ $# -ge 1 ] || usage

echo "Building signer (first run takes a bit, then it's cached)..."
cargo build --release --quiet

BIN="./target/release/metadata-signer"

if [ "$1" = "keygen" ]; then
  if [ -f "$KEY_FILE" ]; then
    echo "$KEY_FILE already exists — refusing to overwrite it."
    echo "If you really want a new key, move or delete $KEY_FILE first"
    echo "(and remember: rotating the key means re-signing everything you"
    echo "already published, and updating OFFICIAL_PUBLIC_KEY_B64 in the app)."
    exit 1
  fi
  "$BIN" keygen
  exit 0
fi

[ $# -ge 2 ] && [ $# -le 3 ] || usage
ENTRY_FILE="$1"
OUT_FILE="$2"
[ $# -eq 3 ] && KEY_FILE="$3"

if [ ! -f "$KEY_FILE" ]; then
  echo "No key file found at $KEY_FILE."
  echo "Run ./sign.sh keygen first, copy your existing signing_key.b64 into"
  echo "this folder (tools/metadata-signer/), or pass its path as the 3rd arg."
  exit 1
fi

if [ ! -f "$ENTRY_FILE" ]; then
  echo "Can't find $ENTRY_FILE"
  exit 1
fi

"$BIN" sign "$ENTRY_FILE" "$OUT_FILE" --key-file "$KEY_FILE"
echo "Done. Publish $OUT_FILE on bearddoddity.github.io — the app verifies"
echo "it automatically against the public key already built in."
