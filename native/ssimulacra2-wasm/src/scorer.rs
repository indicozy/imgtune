// Vendored from ssimulacra2 0.5.0 (https://github.com/rust-av/ssimulacra2), licensed BSD-2-Clause.
// Changed for imgtune: the scoring loop frees planes earlier and works one channel at a time. The arithmetic and the
// order of every sum are unchanged, so the scores are bit-identical to ssimulacra2 0.5.0 (tests/bit_identical.rs).
//
// The license of the vendored code, from ssimulacra2 0.5.0's LICENSE file:
//
// BSD 2-Clause License
//
// Copyright (c) 2022-2022, the rav1e contributors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// - Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
//
// - Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

use crate::blur::Blur;
use yuvxyb::{LinearRgb, Xyb};

// How often to downscale and score the input images.
// Each scaling step will downscale by a factor of two.
const NUM_SCALES: usize = 6;

/// SSIMULACRA2 of `img2` (distorted) against `img1` (source), both in linear RGB and of the same size.
///
/// The result equals ssimulacra2 0.5.0's `compute_frame_ssimulacra2` bit for bit. What differs is when buffers exist:
/// each image's planar XYB is built right after its own downscale, the full-size linear RGB is then freed, and the
/// blur and error maps run one channel at a time.
pub fn compute(img1: LinearRgb, img2: LinearRgb) -> Result<f64, String> {
    if img1.width() != img2.width() || img1.height() != img2.height() {
        return Err("Source and distorted image width and height must be equal".to_string());
    }
    if img1.width() < 8 || img1.height() < 8 {
        return Err("Images must be at least 8x8 pixels".to_string());
    }

    let mut lin1 = img1;
    let mut lin2 = img2;
    let mut blur = Blur::new(lin1.width(), lin1.height());
    let mut msssim = Msssim::default();

    for scale in 0..NUM_SCALES {
        let width = lin1.width();
        let height = lin1.height();
        // Upstream checks the size at the top of each scale, so a scale runs only when the one before it was at
        // least 8x8. That is the test below, applied when the next scale is prepared.
        let more = scale + 1 < NUM_SCALES && width >= 8 && height >= 8;
        blur.shrink_to(width, height);

        let next1 = more.then(|| downscale_by_2(&lin1));
        let planes1 = planar_xyb(&lin1);
        drop(lin1);
        let next2 = more.then(|| downscale_by_2(&lin2));
        let planes2 = planar_xyb(&lin2);
        drop(lin2);

        let (avg_ssim, avg_edgediff) = score_scale(&mut blur, width, height, &planes1, &planes2);
        drop(planes1);
        drop(planes2);
        msssim.scales.push(MsssimScale {
            avg_ssim,
            avg_edgediff,
        });

        match (next1, next2) {
            (Some(a), Some(b)) => {
                lin1 = a;
                lin2 = b;
            }
            _ => break,
        }
    }

    Ok(msssim.score())
}

/// Planar XYB of a linear RGB image, after `make_positive_xyb`, built in bands of rows so the interleaved XYB
/// temporary stays small. The conversion is per pixel, so banding changes no value.
fn planar_xyb(lin: &LinearRgb) -> [Vec<f32>; 3] {
    const BAND_ROWS: usize = 64;

    let width = lin.width();
    let height = lin.height();
    let mut out = [
        vec![0.0f32; width * height],
        vec![0.0f32; width * height],
        vec![0.0f32; width * height],
    ];
    for row0 in (0..height).step_by(BAND_ROWS) {
        let rows = BAND_ROWS.min(height - row0);
        let start = row0 * width;
        let band = LinearRgb::new(
            lin.data()[start..start + rows * width].to_vec(),
            width,
            rows,
        )
        .expect("Resolution and data size match");
        let mut xyb = Xyb::from(band);
        make_positive_xyb(&mut xyb);
        for (i, pix) in xyb.data().iter().enumerate() {
            out[0][start + i] = pix[0];
            out[1][start + i] = pix[1];
            out[2][start + i] = pix[2];
        }
    }
    out
}

/// The per-channel error maps of one scale, the same values as upstream `ssim_map` and `edge_diff_map`, indexed the
/// same way (`c * 2 + n` and `c * 4 + n`). Each channel's sums are independent of the others, so one channel at a
/// time gives the same sums in the same order.
fn score_scale(
    blur: &mut Blur,
    width: usize,
    height: usize,
    img1: &[Vec<f32>; 3],
    img2: &[Vec<f32>; 3],
) -> ([f64; 3 * 2], [f64; 3 * 4]) {
    let n = width * height;
    let mut avg_ssim = [0f64; 3 * 2];
    let mut avg_edgediff = [0f64; 3 * 4];

    for c in 0..3 {
        let mu1 = blur.blur_plane(&img1[c]);
        let mu2 = blur.blur_plane(&img2[c]);

        let mut sigma1_sq = vec![0f32; n];
        multiply_plane(&img1[c], &img1[c], &mut sigma1_sq);
        blur.blur_in_place(&mut sigma1_sq);

        let mut sigma2_sq = vec![0f32; n];
        multiply_plane(&img2[c], &img2[c], &mut sigma2_sq);
        blur.blur_in_place(&mut sigma2_sq);

        let mut sigma12 = vec![0f32; n];
        multiply_plane(&img1[c], &img2[c], &mut sigma12);
        blur.blur_in_place(&mut sigma12);

        let ssim = ssim_plane(width, height, &mu1, &mu2, &sigma1_sq, &sigma2_sq, &sigma12);
        drop(sigma1_sq);
        drop(sigma2_sq);
        drop(sigma12);

        let edge = edge_diff_plane(width, height, &img1[c], &mu1, &img2[c], &mu2);

        avg_ssim[c * 2..c * 2 + 2].copy_from_slice(&ssim);
        avg_edgediff[c * 4..c * 4 + 4].copy_from_slice(&edge);
    }

    (avg_ssim, avg_edgediff)
}

/// Elementwise product of two planes, the per-channel part of upstream `image_multiply`.
fn multiply_plane(p1: &[f32], p2: &[f32], out: &mut [f32]) {
    for ((&a, &b), o) in p1.iter().zip(p2.iter()).zip(out.iter_mut()) {
        *o = a * b;
    }
}

// Get all components in more or less 0..1 range
// Range of Rec2020 with these adjustments:
//  X: 0.017223..0.998838
//  Y: 0.010000..0.855303
//  B: 0.048759..0.989551
// Range of sRGB:
//  X: 0.204594..0.813402
//  Y: 0.010000..0.855308
//  B: 0.272295..0.938012
// The maximum pixel-wise difference has to be <= 1 for the ssim formula to make
// sense.
fn make_positive_xyb(xyb: &mut Xyb) {
    for pix in xyb.data_mut().iter_mut() {
        pix[2] = (pix[2] - pix[1]) + 0.55;
        pix[0] = (pix[0]).mul_add(14.0, 0.42);
        pix[1] += 0.01;
    }
}


fn ssim_plane(
    width: usize,
    height: usize,
    m1: &[f32],
    m2: &[f32],
    s11: &[f32],
    s22: &[f32],
    s12: &[f32],
) -> [f64; 2] {
    const C2: f32 = 0.0009f32;

    let one_per_pixels = 1.0f64 / (width * height) as f64;
    let mut sum1 = [0.0f64; 2];
    for (row_m1, (row_m2, (row_s11, (row_s22, row_s12)))) in m1.chunks_exact(width).zip(
        m2.chunks_exact(width).zip(
            s11.chunks_exact(width)
                .zip(s22.chunks_exact(width).zip(s12.chunks_exact(width))),
        ),
    ) {
        for x in 0..width {
            let mu1 = row_m1[x];
            let mu2 = row_m2[x];
            let mu11 = mu1 * mu1;
            let mu22 = mu2 * mu2;
            let mu12 = mu1 * mu2;
            let mu_diff = mu1 - mu2;

            // Correction applied compared to the original SSIM formula, which has:
            //   luma_err = 2 * mu1 * mu2 / (mu1^2 + mu2^2)
            //            = 1 - (mu1 - mu2)^2 / (mu1^2 + mu2^2)
            // The denominator causes error in the darks (low mu1 and mu2) to weigh
            // more than error in the brights (high mu1 and mu2). This would make
            // sense if values correspond to linear luma. However, the actual values
            // are either gamma-compressed luma (which supposedly is already
            // perceptually uniform) or chroma (where weighing green more than red
            // or blue more than yellow does not make any sense at all). So it is
            // better to simply drop this denominator.
            let num_m = mu_diff.mul_add(-mu_diff, 1.0f32);
            let num_s = 2f32.mul_add(row_s12[x] - mu12, C2);
            let denom_s = (row_s11[x] - mu11) + (row_s22[x] - mu22) + C2;
            // Use 1 - SSIM' so it becomes an error score instead of a quality
            // index. This makes it make sense to compute an L_4 norm.
            let mut d = 1.0f64 - f64::from((num_m * num_s) / denom_s);
            d = d.max(0.0);
            sum1[0] += d;
            sum1[1] += d.powi(4);
        }
    }

    [one_per_pixels * sum1[0], (one_per_pixels * sum1[1]).sqrt().sqrt()]
}

fn edge_diff_plane(
    width: usize,
    height: usize,
    img1: &[f32],
    mu1: &[f32],
    img2: &[f32],
    mu2: &[f32],
) -> [f64; 4] {
    let one_per_pixels = 1.0f64 / (width * height) as f64;
    let mut sum1 = [0.0f64; 4];
    for (row1, (row2, (rowm1, rowm2))) in img1.chunks_exact(width).zip(
        img2.chunks_exact(width)
            .zip(mu1.chunks_exact(width).zip(mu2.chunks_exact(width))),
    ) {
        for x in 0..width {
            let d1: f64 = (1.0 + f64::from((row2[x] - rowm2[x]).abs()))
                / (1.0 + f64::from((row1[x] - rowm1[x]).abs()))
                - 1.0;

            // d1 > 0: distorted has an edge where original is smooth
            //         (indicating ringing, color banding, blockiness, etc)
            let artifact = d1.max(0.0);
            sum1[0] += artifact;
            sum1[1] += artifact.powi(4);

            // d1 < 0: original has an edge where distorted is smooth
            //         (indicating smoothing, blurring, smearing, etc)
            let detail_lost = (-d1).max(0.0);
            sum1[2] += detail_lost;
            sum1[3] += detail_lost.powi(4);
        }
    }

    [
        one_per_pixels * sum1[0],
        (one_per_pixels * sum1[1]).sqrt().sqrt(),
        one_per_pixels * sum1[2],
        (one_per_pixels * sum1[3]).sqrt().sqrt(),
    ]
}

fn downscale_by_2(in_data: &LinearRgb) -> LinearRgb {
    const SCALE: usize = 2;
    let in_w = in_data.width();
    let in_h = in_data.height();
    let out_w = (in_w + SCALE - 1) / SCALE;
    let out_h = (in_h + SCALE - 1) / SCALE;
    let mut out_data = vec![[0.0f32; 3]; out_w * out_h];
    let normalize = 1f32 / (SCALE * SCALE) as f32;

    let in_data = &in_data.data();
    for oy in 0..out_h {
        for ox in 0..out_w {
            for c in 0..3 {
                let mut sum = 0f32;
                for iy in 0..SCALE {
                    for ix in 0..SCALE {
                        let x = (ox * SCALE + ix).min(in_w - 1);
                        let y = (oy * SCALE + iy).min(in_h - 1);
                        let in_pix = in_data[y * in_w + x];

                        sum += in_pix[c];
                    }
                }
                let out_pix = &mut out_data[oy * out_w + ox];
                out_pix[c] = sum * normalize;
            }
        }
    }

    LinearRgb::new(out_data, out_w, out_h).expect("Resolution and data size match")
}

#[derive(Debug, Clone, Default)]
struct Msssim {
    pub scales: Vec<MsssimScale>,
}

#[derive(Debug, Clone, Copy, Default)]
struct MsssimScale {
    pub avg_ssim: [f64; 3 * 2],
    pub avg_edgediff: [f64; 3 * 4],
}

impl Msssim {
    // The final score is based on a weighted sum of 108 sub-scores:
    // - for 6 scales (1:1 to 1:32)
    // - for 6 scales (1:1 to 1:32, downsampled in linear RGB)
    // - for 3 components (X + 0.5, Y, B - Y + 1.0)
    // - for 3 components (X, Y, B-Y, rescaled to 0..1 range)
    // - using 2 norms (the 1-norm and the 4-norm)
    // - using 2 norms (the 1-norm and the 4-norm)
    // - over 3 error maps:
    // - over 3 error maps:
    //     - SSIM
    //     - SSIM' (SSIM without the spurious gamma correction term)
    //     - "ringing" (distorted edges where there are no orig edges)
    //     - "ringing" (distorted edges where there are no orig edges)
    //     - "blurring" (orig edges where there are no distorted edges)
    //     - "blurring" (orig edges where there are no distorted edges)
    // The weights were obtained by running Nelder-Mead simplex search,
    // The weights were obtained by running Nelder-Mead simplex search,
    // optimizing to minimize MSE and maximize Kendall and Pearson correlation
    // optimizing to minimize MSE for the CID22 training set and to
    // for training data consisting of 17611 subjective quality scores,
    // maximize Kendall rank correlation (and with a lower weight,
    // validated on separate validation data consisting of 4292 scores.
    // also Pearson correlation) with the CID22 training set and the
    // TID2013, Kadid10k and KonFiG-IQA datasets.
    // Validation was done on the CID22 validation set.
    // Final results after tuning (Kendall | Spearman | Pearson):
    //    CID22:     0.6903 | 0.8805 | 0.8583
    //    TID2013:   0.6590 | 0.8445 | 0.8471
    //    KADID-10k: 0.6175 | 0.8133 | 0.8030
    //    KonFiG(F): 0.7668 | 0.9194 | 0.9136
    #[allow(clippy::too_many_lines)]
    pub fn score(&self) -> f64 {
        const WEIGHT: [f64; 108] = [
            0.0,
            0.000_737_660_670_740_658_6,
            0.0,
            0.0,
            0.000_779_348_168_286_730_9,
            0.0,
            0.0,
            0.000_437_115_573_010_737_9,
            0.0,
            1.104_172_642_665_734_6,
            0.000_662_848_341_292_71,
            0.000_152_316_327_837_187_52,
            0.0,
            0.001_640_643_745_659_975_4,
            0.0,
            1.842_245_552_053_929_8,
            11.441_172_603_757_666,
            0.0,
            0.000_798_910_943_601_516_3,
            0.000_176_816_438_078_653,
            0.0,
            1.878_759_497_954_638_7,
            10.949_069_906_051_42,
            0.0,
            0.000_728_934_699_150_807_2,
            0.967_793_708_062_683_3,
            0.0,
            0.000_140_034_242_854_358_84,
            0.998_176_697_785_496_7,
            0.000_319_497_559_344_350_53,
            0.000_455_099_211_379_206_3,
            0.0,
            0.0,
            0.001_364_876_616_324_339_8,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            7.466_890_328_078_848,
            0.0,
            17.445_833_984_131_262,
            0.000_623_560_163_404_146_6,
            0.0,
            0.0,
            6.683_678_146_179_332,
            0.000_377_244_079_796_112_96,
            1.027_889_937_768_264,
            225.205_153_008_492_74,
            0.0,
            0.0,
            19.213_238_186_143_016,
            0.001_140_152_458_661_836_1,
            0.001_237_755_635_509_985,
            176.393_175_984_506_94,
            0.0,
            0.0,
            24.433_009_998_704_76,
            0.285_208_026_121_177_57,
            0.000_448_543_692_383_340_8,
            0.0,
            0.0,
            0.0,
            34.779_063_444_837_72,
            44.835_625_328_877_896,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.000_868_055_657_329_169_8,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.000_531_319_187_435_874_7,
            0.0,
            0.000_165_338_141_613_791_12,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.000_417_917_180_325_133_6,
            0.001_729_082_823_472_283_3,
            0.0,
            0.002_082_700_584_663_643_7,
            0.0,
            0.0,
            8.826_982_764_996_862,
            23.192_433_439_989_26,
            0.0,
            95.108_049_881_108_6,
            0.986_397_803_440_068_2,
            0.983_438_279_246_535_3,
            0.001_228_640_504_827_849_3,
            171.266_725_589_730_7,
            0.980_785_887_243_537_9,
            0.0,
            0.0,
            0.0,
            0.000_513_006_458_899_067_9,
            0.0,
            0.000_108_540_578_584_115_37,
        ];

        let mut ssim = 0.0f64;

        let mut i = 0usize;
        for c in 0..3 {
            for scale in &self.scales {
                for n in 0..2 {
                    ssim = WEIGHT[i].mul_add(scale.avg_ssim[c * 2 + n].abs(), ssim);
                    i += 1;
                    ssim = WEIGHT[i].mul_add(scale.avg_edgediff[c * 4 + n].abs(), ssim);
                    i += 1;
                    ssim = WEIGHT[i].mul_add(scale.avg_edgediff[c * 4 + n + 2].abs(), ssim);
                    i += 1;
                }
            }
        }

        ssim *= 0.956_238_261_683_484_4_f64;
        ssim = (6.248_496_625_763_138e-5 * ssim * ssim).mul_add(
            ssim,
            2.326_765_642_916_932f64.mul_add(ssim, -0.020_884_521_182_843_837 * ssim * ssim),
        );

        if ssim > 0.0f64 {
            ssim = ssim
                .powf(0.627_633_646_783_138_7)
                .mul_add(-10.0f64, 100.0f64);
        } else {
            ssim = 100.0f64;
        }

        ssim
    }
}
