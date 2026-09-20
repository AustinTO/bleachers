#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname)" == "Darwin" ]] || { echo "iOS XCFramework build requires macOS/Xcode" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="$($ROOT/scripts/fetch-and-patch.sh)"
OUT="$ROOT/.native-build/ios"
BINDINGS="$OUT/bindings"
LIBS="$OUT/libs"
rm -rf "$OUT"
mkdir -p "$BINDINGS" "$LIBS"

command -v cargo >/dev/null || { echo "cargo/rustup is required" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "xcodebuild is required" >&2; exit 1; }
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# Generate UniFFI Swift bindings from a host build.
"$WT/rs/web-transport-ffi/build.sh" --bindings-only --output "$BINDINGS"

for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  "$WT/rs/web-transport-ffi/build.sh" --target "$target" --output "$OUT/stage"
  mkdir -p "$LIBS/$target"
  cp "$WT/target/$target/release/libweb_transport_ffi.a" "$LIBS/$target/"
done

SWIFT_BINDINGS="$BINDINGS/bindings/swift"
for f in web_transportFFI.h web_transportFFI.modulemap web_transport.swift; do
  [[ -f "$SWIFT_BINDINGS/$f" ]] || { echo "Missing generated Swift binding: $f" >&2; exit 1; }
done

STAGE="$OUT/xcstage"
HEADERS="$STAGE/headers"
mkdir -p "$HEADERS"
cp "$SWIFT_BINDINGS/web_transportFFI.h" "$HEADERS/"
cp "$SWIFT_BINDINGS/web_transportFFI.modulemap" "$HEADERS/module.modulemap"

SIM_FAT="$STAGE/libweb_transport_ffi-iossim.a"
lipo -create \
  "$LIBS/aarch64-apple-ios-sim/libweb_transport_ffi.a" \
  "$LIBS/x86_64-apple-ios/libweb_transport_ffi.a" \
  -output "$SIM_FAT"

rm -rf "$ROOT/ios/vendor/WebTransportFFI.xcframework"
mkdir -p "$ROOT/ios/vendor"
xcodebuild -create-xcframework \
  -library "$LIBS/aarch64-apple-ios/libweb_transport_ffi.a" -headers "$HEADERS" \
  -library "$SIM_FAT" -headers "$HEADERS" \
  -output "$ROOT/ios/vendor/WebTransportFFI.xcframework"
cp "$SWIFT_BINDINGS/web_transport.swift" "$ROOT/ios/WebTransportGenerated.swift"

echo "Patched iOS FFI vendored into ios/vendor and ios/WebTransportGenerated.swift."
