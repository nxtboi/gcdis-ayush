const isProd = process.env.NODE_ENV === 'production';

const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), idle-detection=(), browsing-topics=(), interest-cohort=(), payment=(), fullscreen=(self)';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Do not advertise the framework in an X-Powered-By header
  poweredByHeader: false,
  transpilePackages: ['@gcdis/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive'
          },
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
            // Powerful features off, including payment (the console takes no payments)
            value: PERMISSIONS_POLICY
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : [])
        ]
      }
    ];
  }
};

module.exports = nextConfig;
