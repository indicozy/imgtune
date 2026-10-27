import { withSentryConfig } from '@sentry/nextjs';
import { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { PHASE_DEVELOPMENT_SERVER } from 'next/dist/shared/lib/constants';

const withNextIntl = createNextIntlPlugin();

type F = (phase: string) => NextConfig;
const nextConfig: F = (phase) => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  return {
    reactCompiler: !isDev,
    experimental: {
      // Filesystem cache is disabled in dev to avoid SWC native-side memory growth
      turbopackFileSystemCacheForDev: true,
      // Rewrites CJS barrel imports (e.g. `import { isEmpty } from 'lodash'`) to direct
      // submodule imports so unused code in these packages isn't bundled. lucide-react is
      // already covered by Next's built-in defaults, so it's not listed here.
      optimizePackageImports: ['lodash', 'framer-motion', 'date-fns', '@microsoft/clarity'],
    },
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
    assetPrefix:
      isDev || process.env.NEXT_PUBLIC_NODE_ENV === 'qaprod'
        ? undefined
        : process.env.NEXT_PUBLIC_CDN_URL,
    cacheMaxMemorySize: 0, // disable default in-memory caching
    ...(process.env.NEXT_CACHE_HANDLER === 'redis'
      ? { cacheHandler: require.resolve('./cache-handler.mjs') }
      : {}),
  };
};
const res = (phase: string) => withNextIntl(nextConfig(phase));

// Set NEXT_PUBLIC_SENTRY_ENABLED=false in .env.local to skip Sentry build instrumentation entirely.
const sentryEnabled = process.env.NEXT_PUBLIC_SENTRY_ENABLED !== 'false';

export default sentryEnabled
  ? withSentryConfig(res, {
      // For all available options, see:
      // https://www.npmjs.com/package/@sentry/webpack-plugin#options

      org: process.env.SENTRY_ORG || 'shop-v1',

      project: process.env.SENTRY_PROJECT || 'shop_next',

      // Only print logs for uploading source maps in CI
      silent: !process.env.CI,

      // For all available options, see:
      // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

      // Upload a larger set of source maps for prettier stack traces (increases build time)
      widenClientFileUpload: true,

      webpack: {
        // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
        // See the following for more information:
        // https://docs.sentry.io/product/crons/
        // https://vercel.com/docs/cron-jobs
        automaticVercelMonitors: true,

        // Tree-shaking options for reducing bundle size
        treeshake: {
          // Automatically tree-shake Sentry logger statements to reduce bundle size
          removeDebugLogging: true,
        },
      },
    })
  : res;
