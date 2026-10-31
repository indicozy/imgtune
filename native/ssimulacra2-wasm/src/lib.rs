mod blur;
mod scorer;

use wasm_bindgen::prelude::*;
use yuvxyb::{ColorPrimaries, LinearRgb, Rgb, TransferCharacteristic};

/// Builds a linear-light frame from tightly packed RGBA8 (alpha ignored), the same input model as ssimulacra2_rs
/// (image::open -> to_rgb32f -> Rgb::new). The sRGB to linear step is yuvxyb's `LinearRgb::try_from(Rgb)`, which
/// ssimulacra2 0.5.0 also uses. It reuses the Rgb buffer, so one image costs one buffer here.
fn linear_frame_from_rgba(buf: &[u8], width: usize, height: usize) -> Result<LinearRgb, String> {
    let data: Vec<[f32; 3]> = buf
        .chunks_exact(4)
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    let rgb = Rgb::new(data, width, height, TransferCharacteristic::SRGB, ColorPrimaries::BT709)
        .map_err(|e| e.to_string())?;
    LinearRgb::try_from(rgb).map_err(|_| "Failed to convert input image to linear RGB".to_string())
}

/// Native-or-wasm shared core: SSIMULACRA2 of `dst` against `src`, both RGBA8 of `width` x `height`.
pub fn score_rgba(width: usize, height: usize, src: &[u8], dst: &[u8]) -> Result<f64, String> {
    let expected = width * height * 4;
    if src.len() != expected || dst.len() != expected {
        return Err(format!("expected {expected} RGBA bytes per image, got {} and {}", src.len(), dst.len()));
    }
    let a = linear_frame_from_rgba(src, width, height)?;
    let b = linear_frame_from_rgba(dst, width, height)?;
    scorer::compute(a, b)
}

/// SSIMULACRA2 score (100 = identical, lower = worse) of `dst` against `src`.
/// Both buffers are RGBA8, `width * height * 4` bytes each, row-major, top-left first.
#[wasm_bindgen]
pub fn score(width: u32, height: u32, src: &[u8], dst: &[u8]) -> Result<f64, JsError> {
    score_rgba(width as usize, height as usize, src, dst).map_err(|e| JsError::new(&e))
}
