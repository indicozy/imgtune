#!/usr/bin/env bash
# Rebuilds vendor/ssimulacra2/ (the SSIMULACRA2 WebAssembly module and its CommonJS glue) from native/ssimulacra2-wasm.
# Users of imgtune never run this; the built files are committed. Builds run on the E-cores (16-19), 4 jobs at most.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/native/ssimulacra2-wasm"
OUT="$ROOT/vendor/ssimulacra2"
TARGET=wasm32-unknown-unknown
BINDGEN_VERSION=0.2.129

if ! rustup target list --installed 2>/dev/null | grep -qx "$TARGET"; then
  echo "missing rust target: run rustup target add $TARGET" >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "missing wasm-bindgen: run cargo install wasm-bindgen-cli --version $BINDGEN_VERSION --locked" >&2
  exit 1
fi
found=$(wasm-bindgen --version | awk '{print $2}')
if [ "$found" != "$BINDGEN_VERSION" ]; then
  echo "wasm-bindgen $found found, the glue must come from $BINDGEN_VERSION (the crate's wasm-bindgen pin)" >&2
  exit 1
fi

# The committed module must not carry this machine's paths: remap the cargo registry, the rustup
# toolchain and the repo root to fixed names. Computed from the environment, nothing is hard-coded.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_HOME_DIR="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="--remap-path-prefix=$CARGO_HOME_DIR/registry/src=/cargo-registry --remap-path-prefix=$RUSTUP_HOME_DIR=/rustup --remap-path-prefix=$ROOT=/build"

CARGO_BUILD_JOBS=4 cargo build --manifest-path "$CRATE/Cargo.toml" --lib --release --locked --target "$TARGET"

mkdir -p "$OUT"
wasm-bindgen --target nodejs --out-dir "$OUT" --out-name ssim_wasm \
  "$CRATE/target/$TARGET/release/ssim_wasm.wasm"
# The package is "type": "module", so the CommonJS glue needs the .cjs extension to load.
mv "$OUT/ssim_wasm.js" "$OUT/ssim_wasm.cjs"
echo "built $OUT/ssim_wasm.cjs and ssim_wasm_bg.wasm"
