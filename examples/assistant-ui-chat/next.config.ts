import type { NextConfig } from 'next';

const config: NextConfig = {
  // This example lives inside another project; keep Turbopack's root here.
  turbopack: { root: __dirname },
  async headers() {
    // Cross-origin isolation lets ONNX Runtime run multithreaded WASM (without it, inference is single-threaded).
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};

export default config;
