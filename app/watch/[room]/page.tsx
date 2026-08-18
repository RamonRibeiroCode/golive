'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import StatsOverlay from '@/components/StatsOverlay';
import { connect, type ServerMessage, type Signaling } from '@/lib/signaling';
import { EMPTY, readStats, type Metrics } from '@/lib/stats';
import { createPeer, DEFAULTS, iceServers, tuneReceiver, tuneSdp, type Settings } from '@/lib/webrtc';

type Status = 'connecting' | 'waiting' | 'negotiating' | 'live';

const LABEL: Record<Status, string> = {
  connecting: 'conectando',
  waiting: 'aguardando a transmissão',
  negotiating: 'negociando',
  live: 'ao vivo',
};

export default function WatchPage() {
  const room = String(useParams().room ?? '').toUpperCase();

  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>(EMPTY);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sigRef = useRef<Signaling | null>(null);
  const pendingRef = useRef<RTCIceCandidateInit[]>([]);
  const iceRef = useRef<RTCIceServer[]>([]);

  const teardown = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    pendingRef.current = [];
    if (videoRef.current) videoRef.current.srcObject = null;
    setMetrics(EMPTY);
  }, []);

  const answer = useCallback(async (offer: RTCSessionDescriptionInit, tune?: Partial<Settings>) => {
    teardown();
    setStatus('negotiating');
    const settings: Settings = { ...DEFAULTS, ...tune };

    const pc = createPeer(iceRef.current);
    pcRef.current = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) sigRef.current?.send({ type: 'signal', data: { candidate: event.candidate.toJSON() } });
    };
    pc.ontrack = (event) => {
      // Minimal jitter buffer: we want the frame on screen, not buffered.
      tuneReceiver(event.receiver, 0);
      if (videoRef.current && videoRef.current.srcObject !== event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch(() => {});
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc !== pcRef.current) return;
      if (pc.connectionState === 'connected') setStatus('live');
      if (pc.connectionState === 'failed') {
        setError('conexão falhou — sem rota entre os dois pontos (precisa de TURN?)');
        setStatus('waiting');
      }
    };

    await pc.setRemoteDescription(offer);
    for (const candidate of pendingRef.current.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});

    const local = await pc.createAnswer();
    // Our answer is what the sender's encoder reads: ask for stereo and for the
    // bitrate range the host picked, otherwise libwebrtc falls back to mono/low.
    local.sdp = tuneSdp(local.sdp!, { settings, allowInsert: true });
    await pc.setLocalDescription(local);
    sigRef.current?.send({ type: 'signal', data: { sdp: pc.localDescription } });
  }, [teardown]);

  useEffect(() => {
    let disposed = false;

    (async () => {
      iceRef.current = await iceServers();
      if (disposed) return;

      sigRef.current = connect(room, 'viewer', {
        onMessage: async (msg: ServerMessage) => {
          if (msg.type === 'no-host' || msg.type === 'host-left') {
            teardown();
            setStatus('waiting');
          } else if (msg.type === 'host-ready') {
            setStatus('negotiating');
          } else if (msg.type === 'error') {
            setError(msg.message);
          } else if (msg.type === 'signal') {
            const data = msg.data as any;
            if (data.sdp?.type === 'offer') {
              setError('');
              await answer(data.sdp, data.tune);
            } else if (data.candidate) {
              if (pcRef.current?.remoteDescription) {
                await pcRef.current.addIceCandidate(data.candidate).catch(() => {});
              } else {
                pendingRef.current.push(data.candidate);
              }
            }
          }
        },
        onClose: () => {
          if (!disposed) {
            setStatus('waiting');
            setError('sinalização caiu — recarregue a página');
          }
        },
      });
    })();

    return () => {
      disposed = true;
      sigRef.current?.close();
      sigRef.current = null;
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [room, answer, teardown]);

  useEffect(() => {
    if (status !== 'live') return;
    let previous: Parameters<typeof readStats>[2] = null;
    const timer = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      const result = await readStats(pc, 'in', previous);
      previous = result.snapshot;
      setMetrics(result.metrics);
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  const unmute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.volume = 1;
    video.play().catch(() => {});
    setMuted(false);
  };

  const fullscreen = () => videoRef.current?.parentElement?.requestFullscreen().catch(() => {});

  return (
    <main className="stage">
      <header className="bar">
        <Link href="/" className="logo" style={{ fontSize: 16, textDecoration: 'none' }}>
          go<span>live</span>
        </Link>
        <span className="tag">{room}</span>
        <span className={`dot ${status === 'live' ? 'live' : ''}`}>{LABEL[status]}</span>
        <span className="grow" />
        {error && <span className="dot bad">{error}</span>}
        <button onClick={() => setShowStats((v) => !v)}>{showStats ? 'ocultar stats' : 'stats'}</button>
        {muted && (
          <button onClick={unmute} title="O navegador bloqueia áudio automático">
            ativar som
          </button>
        )}
        <button className="primary" onClick={fullscreen}>
          Tela cheia
        </button>
      </header>

      <div className="screen">
        <video ref={videoRef} autoPlay muted={muted} playsInline />
        {status !== 'live' && (
          <div className="empty">
            <p>{LABEL[status]}…</p>
            <p className="hint">A tela aparece sozinha assim que a transmissão começar.</p>
          </div>
        )}
        {status === 'live' && showStats && <StatsOverlay metrics={metrics} side="in" />}
      </div>
    </main>
  );
}
