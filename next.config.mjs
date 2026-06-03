/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse / pdfjs-dist must not be bundled by webpack for the server
    // build — bundling them throws "Object.defineProperty called on
    // non-object" at module load. Marking them external makes Next require
    // them natively at runtime (the same way the CLI does).
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist"],
  },
};

export default nextConfig;
