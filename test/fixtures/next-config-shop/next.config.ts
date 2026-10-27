const nextConfig = {
    images: {
      remotePatterns: [
        { protocol: 'https', hostname: 'shop-cdn.example.com' },
        { protocol: 'https', hostname: 'cdn-ctf.shop.example' },
        { protocol: 'https', hostname: 'cdn-uat.shop.example' },
        { protocol: 'https', hostname: 'maps.googleapis.com' },
        { protocol: 'https', hostname: 'images.ctfassets.net' },
        { protocol: 'https', hostname: 'shopprescriptions.s3.ap-southeast-1.amazonaws.com' },
        { protocol: 'https', hostname: 'dfstudio-d420.kxcdn.com' },
        { protocol: 'https', hostname: 'shop-prescriptions.s3.ap-southeast-1.amazonaws.com' },
      ],
      deviceSizes: [
        // --- 1x / Legacy / Small Mobile ---
        320, 375, 414, 480,
        // --- iPhone 2x & Mid-range Desktop ---
        640, 750, 828,
        // --- iPhone 3x & HD Desktop ---
        1080, 1125, 1170, 1179, 1200, 1242, 1284, 1290, 1320,
        // --- Large Desktop / Ultra-wide ---
        1440, 1920,
      ],
      imageSizes: [16, 32, 48, 64, 96, 128, 144, 192, 256, 384],
      qualities: [75, 85, 100],
      minimumCacheTTL: 14400, // 4 hours
      loader: 'custom',
      loaderFile: './src/lib/imageLoader.ts',
    },
};

function withSomething<T>(config: T): T {
  return config;
}

export default withSomething(nextConfig);
