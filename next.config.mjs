/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silence warnings from node: imports used in verify-email.js
  serverExternalPackages: ['net', 'dns'],
};

export default nextConfig;
