const sizes = [640, 1280];
module.exports = wrap({
  images: {
    deviceSizes: sizes,
    imageSizes: [16, 48],
    formats: ["image/avif", "image/webp"],
    qualities: [60, 90],
  },
});
