export const dynamic = 'force-dynamic';

/**
 * STUN is enough on the same LAN or with cooperative NATs. For streaming across
 * the internet, point TURN_URL/TURN_USERNAME/TURN_CREDENTIAL at a TURN server.
 */
export function GET() {
  const stun = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const iceServers: RTCIceServer[] = [{ urls: stun }];

  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((u) => u.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return Response.json({ iceServers });
}
