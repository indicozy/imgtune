const nextConfig = {
  images: {
    deviceSizes: [320, 375, 414, 480, 640, 750, 828, 1080, 1125, 1170, 1179, 1200, 1242, 1284, 1290, 1320, 1440, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 144, 192, 256, 384],
    qualities: [75, 85, 100],
    loader: 'custom',
    loaderFile: './src/lib/imageLoader.ts',
  },
};

function withWrapper<T>(config: T): T {
  return config;
}

export default withWrapper(nextConfig);
