//! The vendored scorer must return exactly the f64 that ssimulacra2 0.5.0's `compute_frame_ssimulacra2` returns for the
//! same input. Every comparison is on `to_bits()`, so a single ulp of drift fails.
//!
//! The synthetic part runs anywhere and covers odd sizes, including sizes where the scale count stops early.
//! The real-image part reads every JPEG/PNG/WebP file in the directory named by `SSIM_TEST_IMAGES` and skips when it
//! is unset. Run it in release mode, since the reference is slow in debug:
//!
//!     SSIM_TEST_IMAGES=/path/to/images cargo test --release --test bit_identical

use std::path::{Path, PathBuf};

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ExtendedColorType, RgbaImage};
use ssimulacra2::{ColorPrimaries, Rgb, TransferCharacteristic};

/// The reference: ssimulacra2 0.5.0 on the same input model as `score_rgba` (RGBA8 to sRGB/BT.709 `Rgb`).
fn reference_score(width: usize, height: usize, src: &[u8], dst: &[u8]) -> Result<f64, String> {
    let frame = |buf: &[u8]| -> Rgb {
        let data: Vec<[f32; 3]> = buf
            .chunks_exact(4)
            .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
            .collect();
        Rgb::new(data, width, height, TransferCharacteristic::SRGB, ColorPrimaries::BT709).unwrap()
    };
    ssimulacra2::compute_frame_ssimulacra2(frame(src), frame(dst)).map_err(|e| e.to_string())
}

/// Compares the vendored score with the reference, bit for bit (or the same error text). Returns the score.
fn check(label: &str, width: usize, height: usize, src: &[u8], dst: &[u8]) -> Result<f64, String> {
    let ours = ssim_wasm::score_rgba(width, height, src, dst);
    let theirs = reference_score(width, height, src, dst);
    match (&ours, &theirs) {
        (Ok(a), Ok(b)) => assert_eq!(
            a.to_bits(),
            b.to_bits(),
            "{label} {width}x{height}: vendored {a:?} differs from upstream {b:?}"
        ),
        (Err(a), Err(b)) => assert_eq!(a, b, "{label} {width}x{height}: error text differs"),
        _ => panic!("{label} {width}x{height}: vendored {ours:?}, upstream {theirs:?}"),
    }
    ours
}

struct Lcg(u64);

impl Lcg {
    fn next_u8(&mut self) -> u8 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 56) as u8
    }
}

/// A gradient with hard-edged blocks and a little noise, so every term of the metric gets some signal.
fn synthetic(width: usize, height: usize, seed: u64) -> Vec<u8> {
    let mut rng = Lcg(seed);
    let mut out = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        for x in 0..width {
            let base = [
                (x * 255 / width) as u8,
                (y * 255 / height) as u8,
                ((x * 7 + y * 13) % 256) as u8,
            ];
            let edge = if (x / 5 + y / 7) % 3 == 0 { 40u8 } else { 0 };
            for b in base {
                let noise = rng.next_u8() % 9;
                out.push(b.saturating_add(edge).saturating_sub(4).saturating_add(noise));
            }
            out.push(255);
        }
    }
    out
}

fn noisy(src: &[u8], seed: u64, amplitude: u8) -> Vec<u8> {
    let mut rng = Lcg(seed);
    src.iter()
        .enumerate()
        .map(|(i, &v)| {
            if i % 4 == 3 {
                return v;
            }
            let d = rng.next_u8() % (2 * amplitude + 1);
            v.saturating_add(d).saturating_sub(amplitude)
        })
        .collect()
}

/// Quantised channels, like a coarse JPEG or palette step.
fn posterized(src: &[u8], step: u8) -> Vec<u8> {
    src.iter()
        .enumerate()
        .map(|(i, &v)| if i % 4 == 3 { v } else { (v / step) * step + step / 2 })
        .collect()
}

/// The image moved one pixel to the left, so every vertical edge is off by one.
fn shifted(src: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let sx = (x + 1).min(width - 1);
            out.extend_from_slice(&src[(y * width + sx) * 4..(y * width + sx) * 4 + 4]);
        }
    }
    out
}

/// A 3x3 box blur of the colour channels, computed in integers.
fn box_blur(src: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = src.to_vec();
    for y in 0..height {
        for x in 0..width {
            for c in 0..3 {
                let mut sum = 0u32;
                let mut n = 0u32;
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let (ny, nx) = (y as i64 + dy, x as i64 + dx);
                        if ny < 0 || nx < 0 || ny >= height as i64 || nx >= width as i64 {
                            continue;
                        }
                        sum += u32::from(src[(ny as usize * width + nx as usize) * 4 + c]);
                        n += 1;
                    }
                }
                out[(y * width + x) * 4 + c] = (sum / n) as u8;
            }
        }
    }
    out
}

#[test]
fn synthetic_images_match_upstream_bit_for_bit() {
    // (8, 8) and (8, 13) stop after one scale, (9, 9) and (17, 17) after two, (15, 16) after three, and
    // (1001, 667) runs all six.
    let sizes = [
        (8, 8),
        (8, 13),
        (13, 8),
        (9, 9),
        (15, 16),
        (16, 16),
        (17, 17),
        (33, 9),
        (64, 64),
        (200, 150),
        (1001, 667),
    ];
    for (i, &(w, h)) in sizes.iter().enumerate() {
        let src = synthetic(w, h, 1000 + i as u64);
        let variants = [
            ("identical", src.clone()),
            ("noise", noisy(&src, 7 + i as u64, 12)),
            ("posterized", posterized(&src, 32)),
            ("shifted", shifted(&src, w, h)),
            ("box blur", box_blur(&src, w, h)),
        ];
        for (label, dst) in &variants {
            let score = check(label, w, h, &src, dst).expect("sizes of 8x8 and up are scored");
            if *label == "identical" {
                assert_eq!(score, 100.0, "identical images score 100 at {w}x{h}");
            }
        }
    }
}

#[test]
fn too_small_images_fail_the_same_way() {
    let src = synthetic(8, 7, 3);
    let dst = noisy(&src, 4, 6);
    let err = check("too small", 8, 7, &src, &dst).expect_err("8x7 is rejected");
    assert_eq!(err, "Images must be at least 8x8 pixels");
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("jpg" | "jpeg" | "png" | "webp")
    )
}

fn jpeg_roundtrip(img: &RgbaImage, quality: u8) -> RgbaImage {
    let rgb: Vec<u8> = img.as_raw().chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, quality)
        .encode(&rgb, img.width(), img.height(), ExtendedColorType::Rgb8)
        .expect("JPEG encode");
    image::load_from_memory(&encoded).expect("JPEG decode").to_rgba8()
}

#[test]
fn real_images_match_upstream_bit_for_bit() {
    let Some(dir) = std::env::var_os("SSIM_TEST_IMAGES") else {
        eprintln!("SSIM_TEST_IMAGES is not set, so the real-image comparison is skipped");
        return;
    };
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("SSIM_TEST_IMAGES is a readable directory")
        .map(|e| e.expect("directory entry").path())
        .filter(|p| is_image(p))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "no JPEG/PNG/WebP files in SSIM_TEST_IMAGES");

    for path in paths {
        let name = path.file_name().expect("file name").to_string_lossy().into_owned();
        let original = image::open(&path).expect("decode").to_rgba8();
        let (w0, h0) = original.dimensions();

        // The image at its own size against a JPEG round trip of itself.
        let j40 = jpeg_roundtrip(&original, 40);
        check(&format!("{name} native, jpeg q40"), w0 as usize, h0 as usize, original.as_raw(), j40.as_raw())
            .expect("scored");

        // A 1001x667 resize (odd width, all six scales) against JPEG q40, JPEG q90 and a resample through 500x333.
        let src = image::imageops::resize(&original, 1001, 667, FilterType::Triangle);
        let down = image::imageops::resize(&src, 500, 333, FilterType::Triangle);
        let resampled = image::imageops::resize(&down, 1001, 667, FilterType::Triangle);
        let jpeg40 = jpeg_roundtrip(&src, 40);
        let jpeg90 = jpeg_roundtrip(&src, 90);
        for (label, dst) in [("jpeg q40", &jpeg40), ("jpeg q90", &jpeg90), ("resample 500x333", &resampled)] {
            check(&format!("{name} 1001x667, {label}"), 1001, 667, src.as_raw(), dst.as_raw()).expect("scored");
        }

        // A small thumbnail with JPEG distortion (fewer scales).
        let small = image::imageops::resize(&original, 37, 29, FilterType::Triangle);
        let small_j = jpeg_roundtrip(&small, 40);
        check(&format!("{name} thumbnail, jpeg q40"), 37, 29, small.as_raw(), small_j.as_raw()).expect("scored");
    }
}
