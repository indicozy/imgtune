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
mod gaussian;

use gaussian::RecursiveGaussian;

/// Structure handling image blur.
///
/// Upstream's `Blur` blurs three planes per call. This version blurs one plane at a time, which the scorer needs to
/// keep one channel's buffers at a time. Both passes and the kernel are upstream's, so each plane's output is the same.
///
/// The width and height of the planes passed in need to match this instance. If the image size shrinks,
/// [`shrink_to`][Self::shrink_to] resizes the internal buffer.
pub struct Blur {
    kernel: RecursiveGaussian,
    temp: Vec<f32>,
    width: usize,
    height: usize,
}

impl Blur {
    /// Create a new [Blur] for images of the given width and height.
    /// This pre-allocates the necessary buffers.
    #[must_use]
    pub fn new(width: usize, height: usize) -> Self {
        Blur {
            kernel: RecursiveGaussian,
            temp: vec![0.0f32; width * height],
            width,
            height,
        }
    }

    /// Truncates the internal buffers to fit images of the given width and height.
    ///
    /// This will [truncate][Vec::truncate] the internal buffers
    /// without affecting the allocated memory.
    pub fn shrink_to(&mut self, width: usize, height: usize) {
        self.temp.truncate(width * height);
        self.width = width;
        self.height = height;
    }

    /// Blur one plane into a new buffer.
    pub fn blur_plane(&mut self, plane: &[f32]) -> Vec<f32> {
        let mut out = vec![0f32; self.width * self.height];
        self.kernel
            .horizontal_pass(plane, &mut self.temp, self.width);
        self.kernel
            .vertical_pass_chunked::<128, 32>(&self.temp, &mut out, self.width, self.height);
        out
    }

    /// Blur one plane in place. The horizontal pass reads the whole plane into `temp` before the vertical pass
    /// writes the result back over it, so the values are those of [`blur_plane`][Self::blur_plane].
    pub fn blur_in_place(&mut self, plane: &mut [f32]) {
        self.kernel
            .horizontal_pass(plane, &mut self.temp, self.width);
        self.kernel
            .vertical_pass_chunked::<128, 32>(&self.temp, plane, self.width, self.height);
    }
}
