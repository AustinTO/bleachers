#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="${1:?web-transport source directory required}"
FFI="$WT/rs/web-transport-ffi"
MOQ_REV="ab1cfffaf988d11c624d1b73b7e6c72e004aed04"
MOQ_SRC="$ROOT/.native-build/moq-rs"
cp "$ROOT/native-publisher/publisher.rs" "$FFI/src/moq_publisher.rs"
if ! grep -q 'pub mod moq_publisher;' "$FFI/src/lib.rs"; then
  printf '\npub mod moq_publisher;\n' >> "$FFI/src/lib.rs"
fi
if [[ ! -f "$MOQ_SRC/moq-transport/src/serve/subgroup.rs" ]]; then
  rm -rf "$MOQ_SRC"
  git clone --depth 1 https://github.com/cloudflare/moq-rs "$MOQ_SRC"
  git -C "$MOQ_SRC" fetch --depth 1 origin "$MOQ_REV"
  git -C "$MOQ_SRC" checkout --force "$MOQ_REV"
fi
python3 "$ROOT/native-publisher/patch-group-ring.py" "$MOQ_SRC/moq-transport/src/serve/subgroup.rs"
if [[ -f /tmp/moq-rs/moq-transport/src/serve/subgroup.rs ]]; then
  python3 "$ROOT/native-publisher/patch-group-ring.py" /tmp/moq-rs/moq-transport/src/serve/subgroup.rs
fi
# Keep these as local paths even when an earlier build left a temporary
# checkout (for example /tmp/moq-rs) in Cargo.toml.  Reusing the generated
# FFI tree must be deterministic and must not depend on that directory still
# existing.
python3 - "$FFI/Cargo.toml" "$MOQ_SRC" <<'PY'
from pathlib import Path
import sys

cargo = Path(sys.argv[1])
moq = Path(sys.argv[2])
text = cargo.read_text()
marker = "\n[dependencies.moq-transport]\n"
if marker in text:
    text = text.split(marker, 1)[0]
text = text.rstrip() + (
    f"\n\n[dependencies.moq-transport]\npath = \"{moq / 'moq-transport'}\"\n"
    f"\n[dependencies.moq-native-ietf]\npath = \"{moq / 'moq-native-ietf'}\"\n"
)
cargo.write_text(text)
PY
