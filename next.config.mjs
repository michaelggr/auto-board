/** @type {import('next').NextConfig} */
const nextConfig = {
  // 原生/Node 专用模块不参与打包，运行时直接 require
  serverExternalPackages: ['better-sqlite3', 'ws', 'elliptic', 'bn.js'],
};
export default nextConfig;
