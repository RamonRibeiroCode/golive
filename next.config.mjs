/** @type {import('next').NextConfig} */
const nextConfig = {
  // WebRTC peers / websockets are created inside effects. React StrictMode
  // double-invokes them in dev, which would open two connections per page.
  reactStrictMode: false,
};

export default nextConfig;
