/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },

  webpack: (config) => {
    // Prevents errors when pdfjs-dist tries to require 'canvas' (not available in browser bundles)
    config.resolve.alias = {
      ...config.resolve.alias,
      canvas: false,
    };

    return config;
  },
}

module.exports = nextConfig
