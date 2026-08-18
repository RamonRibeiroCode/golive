export type Metrics = {
  kbps: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
  impl: string;
  rttMs: number;
  lossPct: number;
  jitterMs: number;
  /** encoder-side reason for downscaling: cpu | bandwidth | none */
  limitation: string;
  /** receiver only */
  bufferMs: number;
  freezes: number;
};

type Snapshot = {
  t: number;
  bytes: number;
  packets: number;
  lost: number;
  jbDelay: number;
  jbCount: number;
};

export const EMPTY: Metrics = {
  kbps: 0,
  fps: 0,
  width: 0,
  height: 0,
  codec: '-',
  impl: '-',
  rttMs: 0,
  lossPct: 0,
  jitterMs: 0,
  limitation: 'none',
  bufferMs: 0,
  freezes: 0,
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function readStats(
  pc: RTCPeerConnection,
  direction: 'out' | 'in',
  previous: Snapshot | null,
): Promise<{ metrics: Metrics; snapshot: Snapshot }> {
  const report = await pc.getStats();
  const wanted = direction === 'out' ? 'outbound-rtp' : 'inbound-rtp';

  let rtp: any = null;
  let remoteInbound: any = null;
  let pair: any = null;

  report.forEach((s: any) => {
    if (s.type === wanted && s.kind === 'video') rtp = s;
    if (s.type === 'remote-inbound-rtp' && s.kind === 'video') remoteInbound = s;
    if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && s.currentRoundTripTime != null) {
      pair = s;
    }
  });

  const now = performance.now();
  const bytes = num(rtp?.[direction === 'out' ? 'bytesSent' : 'bytesReceived']);
  const packets = num(rtp?.[direction === 'out' ? 'packetsSent' : 'packetsReceived']);
  const lost = direction === 'out' ? num(remoteInbound?.packetsLost) : num(rtp?.packetsLost);
  const jbDelay = num(rtp?.jitterBufferDelay);
  const jbCount = num(rtp?.jitterBufferEmittedCount);

  const snapshot: Snapshot = { t: now, bytes, packets, lost, jbDelay, jbCount };

  const metrics: Metrics = { ...EMPTY };
  if (rtp) {
    metrics.fps = Math.round(num(rtp.framesPerSecond));
    metrics.width = num(rtp.frameWidth);
    metrics.height = num(rtp.frameHeight);
    metrics.impl = rtp.encoderImplementation ?? rtp.decoderImplementation ?? '-';
    if (rtp.powerEfficientEncoder === true || rtp.powerEfficientDecoder === true) metrics.impl += ' (hw)';
    metrics.limitation = rtp.qualityLimitationReason ?? 'none';
    metrics.freezes = num(rtp.freezeCount);
    const codec = rtp.codecId ? (report.get(rtp.codecId) as any) : null;
    if (codec?.mimeType) metrics.codec = codec.mimeType.replace('video/', '');
  }

  metrics.jitterMs = Math.round(num(direction === 'out' ? remoteInbound?.jitter : rtp?.jitter) * 1000);
  metrics.rttMs = Math.round(num(pair?.currentRoundTripTime ?? remoteInbound?.roundTripTime) * 1000);

  if (previous) {
    const seconds = (now - previous.t) / 1000;
    if (seconds > 0) metrics.kbps = Math.max(0, Math.round(((bytes - previous.bytes) * 8) / 1000 / seconds));
    const deltaPackets = packets - previous.packets;
    const deltaLost = lost - previous.lost;
    if (deltaPackets + deltaLost > 0) {
      metrics.lossPct = Math.max(0, Math.round((deltaLost / (deltaPackets + deltaLost)) * 1000) / 10);
    }
    const deltaFrames = jbCount - previous.jbCount;
    if (deltaFrames > 0) metrics.bufferMs = Math.round(((jbDelay - previous.jbDelay) / deltaFrames) * 1000);
  }

  return { metrics, snapshot };
}
