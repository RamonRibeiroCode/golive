'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import StatsOverlay from '@/components/StatsOverlay';
import { connect, type ServerMessage, type Signaling } from '@/lib/signaling';
import { EMPTY, readStats, type Metrics } from '@/lib/stats';
import {
  applySenderSettings,
  CODECS,
  createPeer,
  DEFAULTS,
  displayConstraints,
  hintTracks,
  iceServers,
  preferCodec,
  tuneSdp,
  type CodecChoice,
  type Settings,
} from '@/lib/webrtc';

type Peer = { pc: RTCPeerConnection; pending: RTCIceCandidateInit[] };

// AV1/VP9 usually fall back to software encoding: better picture per bit, but they
// cannot hold 1080p60 on most CPUs. H.264 rides the GPU encoder.
const CODEC_LABEL: Record<CodecChoice, string> = {
  auto: 'auto (h264)',
  h264: 'h264 · gpu',
  av1: 'av1 · pesado',
  vp9: 'vp9 · pesado',
  vp8: 'vp8',
};

const RESOLUTIONS = [
  { label: 'Nativa', value: 0 },
  { label: '1440p', value: 1440 },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
];

export default function HostPage() {
  const room = String(useParams().room ?? '').toUpperCase();

  const [live, setLive] = useState(false);
  const [viewers, setViewers] = useState(0);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sigRef = useRef<Signaling | null>(null);
  const peersRef = useRef(new Map<string, Peer>());
  const iceRef = useRef<RTCIceServer[]>([]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /* ------------------------------ peers -------------------------------- */

  const buildPeer = useCallback(async (id: string) => {
    const stream = streamRef.current;
    const sig = sigRef.current;
    if (!stream || !sig) return;

    peersRef.current.get(id)?.pc.close();

    const s = settingsRef.current;
    const pc = createPeer(iceRef.current);
    const peer: Peer = { pc, pending: [] };
    peersRef.current.set(id, peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) sig.send({ type: 'signal', to: id, data: { candidate: event.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.close();
        if (peersRef.current.get(id) === peer) peersRef.current.delete(id);
      }
    };

    for (const track of stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [
          track.kind === 'video'
            ? { maxBitrate: s.bitrate * 1_000_000, maxFramerate: s.fps, networkPriority: 'high' }
            : { maxBitrate: s.audioBitrate * 1000, networkPriority: 'high' },
        ],
      });
      if (track.kind === 'video') preferCodec(transceiver, s.codec);
    }

    const offer = await pc.createOffer();
    offer.sdp = tuneSdp(offer.sdp!, { settings: s, allowInsert: true });
    await pc.setLocalDescription(offer);
    for (const sender of pc.getSenders()) await applySenderSettings(sender, s);

    // The viewer needs our bitrate targets to build a matching answer -- opus only
    // goes stereo if the *receiver* asks for it in its own fmtp line.
    sig.send({
      type: 'signal',
      to: id,
      data: { sdp: pc.localDescription, tune: { bitrate: s.bitrate, audioBitrate: s.audioBitrate } },
    });
  }, []);

  const onSignal = useCallback(async (from: string, data: any) => {
    const peer = peersRef.current.get(from);
    if (!peer) return;

    if (data.sdp?.type === 'answer') {
      const answer: RTCSessionDescriptionInit = {
        type: 'answer',
        sdp: tuneSdp(data.sdp.sdp, { settings: settingsRef.current, allowInsert: false }),
      };
      await peer.pc.setRemoteDescription(answer);
      for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
      for (const sender of peer.pc.getSenders()) await applySenderSettings(sender, settingsRef.current);
      return;
    }

    if (data.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }, []);

  /* ------------------------------ lifecycle ----------------------------- */

  const stop = useCallback(() => {
    for (const { pc } of peersRef.current.values()) pc.close();
    peersRef.current.clear();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    sigRef.current?.close();
    sigRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
    setViewers(0);
    setMetrics(EMPTY);
  }, []);

  const start = useCallback(async () => {
    setError('');
    try {
      iceRef.current = await iceServers();
      const stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints(settingsRef.current));
      hintTracks(stream);
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      stream.getVideoTracks()[0].addEventListener('ended', () => stop());

      sigRef.current = connect(room, 'host', {
        onMessage: (msg: ServerMessage) => {
          if (msg.type === 'error') {
            setError(msg.message);
            stop();
          } else if (msg.type === 'peer-join') {
            buildPeer(msg.id);
            setViewers(peersRef.current.size);
          } else if (msg.type === 'peer-left') {
            peersRef.current.get(msg.id)?.pc.close();
            peersRef.current.delete(msg.id);
            setViewers(peersRef.current.size);
          } else if (msg.type === 'signal') {
            onSignal(msg.from, msg.data);
          }
        },
        onClose: () => setLive(false),
      });
      setLive(true);
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') setError((err as Error).message);
      stop();
    }
  }, [room, buildPeer, onSignal, stop]);

  useEffect(() => stop, [stop]);

  /* ------------------------- live setting changes ----------------------- */

  useEffect(() => {
    if (!live) return;
    const track = streamRef.current?.getVideoTracks()[0];
    const constraints: MediaTrackConstraints = { frameRate: { ideal: settings.fps, max: settings.fps } };
    if (settings.height) {
      constraints.width = { max: Math.round((settings.height * 16) / 9) };
      constraints.height = { max: settings.height };
    }
    track?.applyConstraints(constraints).catch(() => {});
    for (const { pc } of peersRef.current.values()) {
      for (const sender of pc.getSenders()) applySenderSettings(sender, settings);
    }
  }, [live, settings.bitrate, settings.fps, settings.height, settings.audioBitrate]);

  // A codec swap needs a fresh offer, so rebuild every peer connection.
  useEffect(() => {
    if (!live) return;
    for (const id of [...peersRef.current.keys()]) buildPeer(id);
  }, [live, settings.codec, buildPeer]);

  /* -------------------------------- stats ------------------------------- */

  useEffect(() => {
    if (!live) return;
    let previous: Parameters<typeof readStats>[2] = null;
    const timer = setInterval(async () => {
      const pc = peersRef.current.values().next().value?.pc;
      if (!pc) return setMetrics(EMPTY);
      const result = await readStats(pc, 'out', previous);
      previous = result.snapshot;
      setMetrics(result.metrics);
    }, 1000);
    return () => clearInterval(timer);
  }, [live]);

  /* --------------------------------- ui --------------------------------- */

  const copyLink = async () => {
    await navigator.clipboard.writeText(`${location.origin}/watch/${room}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  return (
    <main className="stage">
      <header className="bar">
        <Link href="/" className="logo" style={{ fontSize: 16, textDecoration: 'none' }}>
          go<span>live</span>
        </Link>
        <span className="tag">{room}</span>
        <span className={`dot ${live ? 'live' : ''}`}>
          {live ? `no ar · ${viewers} ${viewers === 1 ? 'espectador' : 'espectadores'}` : 'parado'}
        </span>
        <span className="grow" />
        {error && <span className="dot bad">{error}</span>}
        <button onClick={copyLink}>{copied ? 'copiado!' : 'copiar link'}</button>
        {live ? (
          <button className="danger" onClick={stop}>
            Encerrar
          </button>
        ) : (
          <button className="primary" onClick={start}>
            Compartilhar tela
          </button>
        )}
      </header>

      <div className="screen">
        <video ref={videoRef} autoPlay muted playsInline />
        {!live && (
          <div className="empty">
            <p>Escolha a janela ou o monitor do jogo para começar.</p>
            <p className="hint">
              Quem for assistir abre <code>/watch/{room}</code> na mesma rede.
            </p>
          </div>
        )}
        {live && viewers > 0 && <StatsOverlay metrics={metrics} side="out" />}
      </div>

      <footer className="controls">
        <label className="control">
          bitrate
          <input
            type="range"
            min={1}
            max={50}
            step={1}
            value={settings.bitrate}
            onChange={(e) => set('bitrate', Number(e.target.value))}
          />
          <span className="value">{settings.bitrate} Mb/s</span>
        </label>

        <label className="control">
          fps
          <select value={settings.fps} onChange={(e) => set('fps', Number(e.target.value))}>
            {[30, 48, 60, 90, 120].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          resolução
          <select value={settings.height} onChange={(e) => set('height', Number(e.target.value))}>
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          codec
          <select
            value={settings.codec}
            onChange={(e) => set('codec', e.target.value as CodecChoice)}
          >
            {CODECS.map((c) => (
              <option key={c} value={c}>
                {CODEC_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        <label className="control">
          <input
            type="checkbox"
            checked={settings.audio}
            disabled={live}
            onChange={(e) => set('audio', e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          áudio do sistema
        </label>

        <span className="grow" />
        <span className="hint">bitrate e fps mudam ao vivo · codec e áudio exigem reconexão</span>
      </footer>
    </main>
  );
}
