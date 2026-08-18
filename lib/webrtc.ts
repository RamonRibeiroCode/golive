/**
 * Tuning helpers for low-latency, high-framerate game streaming.
 *
 * The three things that actually matter for fluidity:
 *  1. contentHint = 'motion'      -> encoder trades resolution for framerate
 *  2. degradationPreference       -> 'maintain-framerate' instead of the default balanced
 *  3. start bitrate               -> skips libwebrtc's slow 300kbps ramp-up
 */

export const CODECS = ['auto', 'h264', 'av1', 'vp9', 'vp8'] as const;
export type CodecChoice = (typeof CODECS)[number];

const MIME: Record<Exclude<CodecChoice, 'auto'>, string> = {
  h264: 'video/H264',
  av1: 'video/AV1',
  vp9: 'video/VP9',
  vp8: 'video/VP8',
};

// Hardware H.264 first: lowest encode latency and lowest CPU at 60fps, which is
// what keeps a game feeling smooth. AV1/VP9 look better per bit but are usually
// software-encoded and cannot hold 1080p60.
const AUTO_ORDER = ['video/H264', 'video/AV1', 'video/VP9', 'video/VP8'];

export type Settings = {
  /** Mbps */
  bitrate: number;
  fps: number;
  /** target height, 0 = native */
  height: number;
  codec: CodecChoice;
  audio: boolean;
  /** kbps for opus */
  audioBitrate: number;
};

export const DEFAULTS: Settings = {
  bitrate: 12,
  fps: 60,
  height: 1080,
  codec: 'auto',
  audio: true,
  audioBitrate: 192,
};

/* --------------------------------- ICE ---------------------------------- */

let cachedIce: RTCIceServer[] | null = null;

export async function iceServers(): Promise<RTCIceServer[]> {
  if (cachedIce) return cachedIce;
  try {
    const res = await fetch('/api/ice');
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body.iceServers)) return (cachedIce = body.iceServers);
    }
  } catch {
    /* fall through */
  }
  return (cachedIce = [{ urls: ['stun:stun.l.google.com:19302'] }]);
}

export function createPeer(servers: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: servers,
    // One transport for audio+video: fewer ICE checks, faster connect.
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,
  });
}

/* ------------------------------- capture -------------------------------- */

export function displayConstraints(s: Settings): DisplayMediaStreamOptions {
  const video: Record<string, unknown> = {
    frameRate: { ideal: s.fps, max: s.fps },
    // 'none' keeps the capturer from resampling; we let the encoder scale instead.
    resizeMode: 'none',
    displaySurface: 'monitor',
    cursor: 'always',
  };
  if (s.height) {
    const width = Math.round((s.height * 16) / 9);
    video.width = { max: width };
    video.height = { max: s.height };
  }

  return {
    video,
    // Raw game audio: every DSP stage below would chew the soundtrack up.
    audio: s.audio
      ? ({
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
        } as MediaTrackConstraints)
      : false,
    systemAudio: s.audio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
    preferCurrentTab: false,
  } as DisplayMediaStreamOptions;
}

export function hintTracks(stream: MediaStream) {
  for (const track of stream.getVideoTracks()) track.contentHint = 'motion';
  for (const track of stream.getAudioTracks()) track.contentHint = 'music';
}

/* ------------------------------- codecs --------------------------------- */

function h264Score(codec: RTCRtpCodec): number {
  const fmtp = codec.sdpFmtpLine ?? '';
  let score = 0;
  // Mode 0 (single NAL) fragments badly and stalls on big keyframes.
  if (/packetization-mode=1/.test(fmtp)) score += 100;
  const profile = /profile-level-id=([0-9a-fA-F]{4})/.exec(fmtp)?.[1].toLowerCase() ?? '';
  if (profile === '640c' || profile === '6400') score += 30; // High
  else if (profile === '4d00' || profile === '4d40') score += 20; // Main
  else if (profile === '42e0' || profile === '42c0') score += 10; // Baseline
  return score;
}

/** Reorders (never removes) the codec list so the wanted encoder is picked first. */
export function preferCodec(transceiver: RTCRtpTransceiver, choice: CodecChoice) {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs || !transceiver.setCodecPreferences) return;

  const wanted = choice === 'auto' ? AUTO_ORDER : [MIME[choice]];
  const picked: RTCRtpCodec[] = [];

  for (const mime of wanted) {
    const matches = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
    if (mime === 'video/H264') matches.sort((a, b) => h264Score(b) - h264Score(a));
    picked.push(...matches);
  }
  // Keep the rest (including rtx/red/ulpfec) as fallback, order preserved.
  const rest = caps.codecs.filter((c) => !picked.includes(c));
  if (!picked.length) return;

  try {
    transceiver.setCodecPreferences([...picked, ...rest]);
  } catch {
    /* browser refused the list; default order is fine */
  }
}

/* -------------------------------- sender -------------------------------- */

export async function applySenderSettings(sender: RTCRtpSender, s: Settings) {
  const params = sender.getParameters() as RTCRtpSendParameters & {
    degradationPreference?: RTCDegradationPreference;
  };
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

  const enc = params.encodings[0] as RTCRtpEncodingParameters & {
    networkPriority?: RTCPriorityType;
  };

  if (sender.track?.kind === 'video') {
    enc.maxBitrate = Math.round(s.bitrate * 1_000_000);
    enc.maxFramerate = s.fps;
    enc.scaleResolutionDownBy = 1;
    // Drop resolution before dropping frames -- a blurry 60fps beats a sharp 20fps.
    params.degradationPreference = 'maintain-framerate';
  } else {
    enc.maxBitrate = Math.round(s.audioBitrate * 1000);
  }
  enc.priority = 'high';
  enc.networkPriority = 'high';
  enc.active = true;

  try {
    await sender.setParameters(params);
  } catch {
    /* transient invalid-state during renegotiation; next tick re-applies */
  }
}

/* --------------------------------- SDP ---------------------------------- */

type TuneOptions = { settings: Settings; allowInsert: boolean };

/**
 * Injects libwebrtc's x-google bitrate hints and full-quality opus params.
 * `allowInsert` is only enabled for our own local descriptions -- adding brand
 * new lines to a remote description is a good way to get it rejected.
 */
export function tuneSdp(sdp: string, { settings, allowInsert }: TuneOptions): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const raw = sdp.split(/\r\n|\n/);

  const maxKbps = Math.round(settings.bitrate * 1000);
  const startKbps = Math.round(maxKbps * 0.7);
  const minKbps = Math.max(500, Math.round(maxKbps * 0.15));
  const bitrateParams = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;

  type Section = { kind: 'video' | 'audio' | 'other'; lines: string[] };
  const sections: Section[] = [];
  let current: Section = { kind: 'other', lines: [] };
  for (const line of raw) {
    if (line.startsWith('m=')) {
      sections.push(current);
      current = {
        kind: line.startsWith('m=video') ? 'video' : line.startsWith('m=audio') ? 'audio' : 'other',
        lines: [],
      };
    }
    current.lines.push(line);
  }
  sections.push(current);

  for (const section of sections) {
    if (section.kind === 'video') {
      const payloads: string[] = [];
      for (const line of section.lines) {
        const match = /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1|AV1X)\/90000/i.exec(line);
        if (match) payloads.push(match[1]);
      }
      for (const pt of payloads) {
        const fmtpIndex = section.lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
        if (fmtpIndex >= 0) {
          const cleaned = section.lines[fmtpIndex]
            .split(';')
            .filter((p) => !/^x-google-(start|min|max)-bitrate=/.test(p.trim()))
            .join(';');
          section.lines[fmtpIndex] = `${cleaned};${bitrateParams}`;
        } else if (allowInsert) {
          const rtpmapIndex = section.lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
          if (rtpmapIndex >= 0) section.lines.splice(rtpmapIndex + 1, 0, `a=fmtp:${pt} ${bitrateParams}`);
        }
      }
    }

    if (section.kind === 'audio') {
      const opus = section.lines.find((l) => /^a=rtpmap:\d+ opus\/48000/i.test(l));
      if (!opus) continue;
      const pt = /^a=rtpmap:(\d+)/.exec(opus)![1];
      const desired: Record<string, string> = {
        stereo: '1',
        'sprop-stereo': '1',
        maxaveragebitrate: String(Math.round(settings.audioBitrate * 1000)),
        maxplaybackrate: '48000',
        useinbandfec: '1',
        usedtx: '0',
      };
      const fmtpIndex = section.lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
      if (fmtpIndex >= 0) {
        const params = new Map<string, string>();
        for (const part of section.lines[fmtpIndex].slice(`a=fmtp:${pt} `.length).split(';')) {
          const [k, v] = part.split('=');
          if (k?.trim()) params.set(k.trim(), v ?? '');
        }
        for (const [k, v] of Object.entries(desired)) params.set(k, v);
        section.lines[fmtpIndex] =
          `a=fmtp:${pt} ` +
          [...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
      } else if (allowInsert) {
        const rtpmapIndex = section.lines.indexOf(opus);
        const value = Object.entries(desired).map(([k, v]) => `${k}=${v}`).join(';');
        section.lines.splice(rtpmapIndex + 1, 0, `a=fmtp:${pt} ${value}`);
      }
    }
  }

  return sections.flatMap((s) => s.lines).join(eol);
}

/* -------------------------------- receiver ------------------------------- */

/** Shrinks the jitter buffer so the picture tracks the game instead of trailing it. */
export function tuneReceiver(receiver: RTCRtpReceiver, targetMs = 0) {
  const r = receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
  try {
    r.jitterBufferTarget = targetMs;
  } catch {
    /* unsupported */
  }
  try {
    r.playoutDelayHint = targetMs / 1000;
  } catch {
    /* unsupported */
  }
}
