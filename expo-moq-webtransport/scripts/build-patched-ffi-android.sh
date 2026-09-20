#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="$($ROOT/scripts/fetch-and-patch.sh)"
bash "$ROOT/scripts/install-native-publisher.sh" "$WT"
OUT="$ROOT/.native-build/android"
LIBS="$OUT/libs"
BINDINGS="$OUT/bindings"
rm -rf "$OUT"
mkdir -p "$LIBS" "$BINDINGS"

command -v cargo >/dev/null || { echo "cargo/rustup is required" >&2; exit 1; }
command -v cargo-ndk >/dev/null || { echo "cargo-ndk is required: cargo install cargo-ndk" >&2; exit 1; }
: "${ANDROID_NDK_HOME:?ANDROID_NDK_HOME must point to an Android NDK}"

rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android

# Generate UniFFI Kotlin bindings from a host build.
"$WT/rs/web-transport-ffi/build.sh" --bindings-only --output "$BINDINGS"

for target in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android; do
  "$WT/rs/web-transport-ffi/build.sh" --target "$target" --output "$OUT/stage"
  mkdir -p "$LIBS/$target"
  cp "$WT/target/$target/release/libweb_transport_ffi.so" "$LIBS/$target/"
done

# Vendor generated source + native libs directly into this Expo module.
GEN="$BINDINGS/bindings/kotlin/uniffi/web_transport/web_transport.kt"
DEST_KT="$ROOT/android/src/main/java/uniffi/web_transport"
mkdir -p "$DEST_KT"
cp "$GEN" "$DEST_KT/web_transport.kt"

mkdir -p "$ROOT/android/src/main/jniLibs/arm64-v8a" "$ROOT/android/src/main/jniLibs/armeabi-v7a" "$ROOT/android/src/main/jniLibs/x86_64"
cp "$LIBS/aarch64-linux-android/libweb_transport_ffi.so" "$ROOT/android/src/main/jniLibs/arm64-v8a/"
cp "$LIBS/armv7-linux-androideabi/libweb_transport_ffi.so" "$ROOT/android/src/main/jniLibs/armeabi-v7a/"
cp "$LIBS/x86_64-linux-android/libweb_transport_ffi.so" "$ROOT/android/src/main/jniLibs/x86_64/"

echo "Patched Android FFI vendored into android/src/main."
