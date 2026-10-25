const isProd = process.env.NODE_ENV === 'production';

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), idle-detection=(), browsing-topics=(), interest-cohort=(), payment=(self "https://checkout.razorpay.com" "https://api.razorpay.com"), fullscreen=(self)';

/**
 * Public uploads (sponsor logos, gallery and site images) are served by the API under
 * `<api base>/uploads/files/<name>`. They are loaded through the Next.js image optimiser, which also
 * serves them from this origin (the API sends Cross-Origin-Resource-Policy: same-origin).
 */
function uploadImagePatterns() {
  const raw = process.env.NEXT_PUBLIC_API_URL || (isProd ? '' : 'http://localhost:4000/api');
  if (!raw) return [];
  try {
    const url = new URL(raw);
    const base = url.pathname.replace(/\/$/, '');
    return [
      {
        protocol: url.protocol.replace(':', ''),
        hostname: url.hostname,
        port: url.port,
        pathname: `${base}/uploads/files/**`
      }
    ];
  } catch {
    return [];
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  images: {
    remotePatterns: uploadImagePatterns()
  },
  transpilePackages: ['@gcdis/shared'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'socket.io-client'];
    }
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Content-Security-Policy is set per request (nonce) by src/middleware.ts; see src/lib/csp.ts.
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            // Powerful features off; payment only for this site and the Razorpay Checkout frame
            value: PERMISSIONS_POLICY
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : [])
        ]
      },
      {
        // One-time tokens travel in these URLs: never send them on in a Referer header (later rule wins).
        source: '/portal/:page(verify-email|reset-password)',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' }
        ]
      }
    ];
  }
};

module.exports = nextConfig;
