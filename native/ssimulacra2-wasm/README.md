# ssimulacra2-wasm

WebAssembly build of SSIMULACRA2 used by imgtune's default `ssimulacra2` metric. The built module is committed under
`vendor/ssimulacra2/`, so users do not need Rust. Rebuild it only when this crate changes.

## Build

    scripts/build-wasm.sh

The script runs these steps with 4 jobs at most:

    rustup target add wasm32-unknown-unknown
    cargo install wasm-bindgen-cli --version 0.2.129 --locked
    CARGO_BUILD_JOBS=4 cargo build --manifest-path native/ssimulacra2-wasm/Cargo.toml --lib --release --locked --target wasm32-unknown-unknown
    wasm-bindgen --target nodejs --out-dir vendor/ssimulacra2 --out-name ssim_wasm native/ssimulacra2-wasm/target/wasm32-unknown-unknown/release/ssim_wasm.wasm

and renames the CommonJS glue to `ssim_wasm.cjs`, because the imgtune package is `"type": "module"`.

## Scorer

`src/scorer.rs` and `src/blur/` are vendored from ssimulacra2 0.5.0 (BSD-2-Clause). The arithmetic is upstream's. What
changed is the order of allocation: each image's planar XYB is built right after its own downscale, the full-size
linear RGB is freed before the blur, and the blur and error maps run one channel at a time. Scores do not change; the
peak memory of the scorer does.

## Tests

    CARGO_BUILD_JOBS=4 cargo test --release --locked --test bit_identical
    SSIM_TEST_IMAGES=/path/to/images CARGO_BUILD_JOBS=4 cargo test --release --locked --test bit_identical

`tests/bit_identical.rs` runs the vendored scorer and the upstream `ssimulacra2` crate (a dev-dependency) on the same
RGBA input and asserts that the f64 results match bit for bit. The synthetic cases cover odd sizes down to 8x8, which
change how many scales run. With `SSIM_TEST_IMAGES` set, every JPEG/PNG/WebP file in that directory is also compared
at its own size, at 1001x667 and as a thumbnail, with JPEG and resample distortions.

## Pins

- `Cargo.lock` is committed and the build uses `--locked`. It keeps `ssimulacra2 0.5.0` (the library behind
  `ssimulacra2_rs` 0.5.2) and `yuvxyb 0.4.0`. A fresh resolve pulls `yuvxyb 0.4.2`, which drifts up to 0.033 from the
  native binary's scores. `yuvxyb = "=0.4.0"` is pinned in `Cargo.toml` for the same reason.
- `wasm-bindgen` is pinned to `=0.2.129`, and the CLI must match that version.

## Interface

`score(width, height, src, dst)` takes two RGBA8 buffers of `width * height * 4` bytes, row-major, and returns the
SSIMULACRA2 score (100 for identical images). It throws on a length mismatch or sides under 8 px. Alpha is ignored, so
the caller composites translucent pixels on white first (`src/metric.ts` does this).

## Parity

Against `ssimulacra2_rs` 0.5.2 on 37 pairs, the largest difference was 4.7e-9. Speed is close to the native binary.
SIMD (`simd128`) gave no gain, so the build has it off.

## License

The SSIMULACRA2 library is BSD-2-Clause (see `NOTICE`). This wrapper is part of imgtune.
