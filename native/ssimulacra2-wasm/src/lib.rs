use ssimulacra2::{compute_frame_ssimulacra2, ColorPrimaries, Rgb, TransferCharacteristic};
use wasm_bindgen::prelude::*;

/// Builds an sRGB/BT.709 frame from tightly packed RGBA8 (alpha ignored), the same
/// input model as ssimulacra2_rs (image::open -> to_rgb32f -> Rgb::new).
fn frame_from_rgba(buf: &[u8], width: usize, height: usize) -> Result<Rgb, String> {
    let data: Vec<[f32; 3]> = buf
        .chunks_exact(4)
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    Rgb::new(data, width, height, TransferCharacteristic::SRGB, ColorPrimaries::BT709)
        .map_err(|e| e.to_string())
}

/// Native-or-wasm shared core: SSIMULACRA2 of `dst` against `src`, both RGBA8 of `width` x `height`.
pub fn score_rgba(width: usize, height: usize, src: &[u8], dst: &[u8]) -> Result<f64, String> {
    let expected = width * height * 4;
    if src.len() != expected || dst.len() != expected {
        return Err(format!("expected {expected} RGBA bytes per image, got {} and {}", src.len(), dst.len()));
    }
    let a = frame_from_rgba(src, width, height)?;
    let b = frame_from_rgba(dst, width, height)?;
    compute_frame_ssimulacra2(a, b).map_err(|e| e.to_string())
}

/// SSIMULACRA2 score (100 = identical, lower = worse) of `dst` against `src`.
/// Both buffers are RGBA8, `width * height * 4` bytes each, row-major, top-left first.
#[wasm_bindgen]
pub fn score(width: u32, height: u32, src: &[u8], dst: &[u8]) -> Result<f64, JsError> {
    score_rgba(width as usize, height as usize, src, dst).map_err(|e| JsError::new(&e))
}
