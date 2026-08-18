'use client';

import type { Metrics } from '@/lib/stats';

function level(value: number, warn: number, bad: number) {
  if (value >= bad) return 'bad';
  if (value >= warn) return 'warn';
  return '';
}

export default function StatsOverlay({ metrics, side }: { metrics: Metrics; side: 'out' | 'in' }) {
  const mbps = (metrics.kbps / 1000).toFixed(1);
  return (
    <dl className="stats">
      <dt>resolução</dt>
      <dd>
        {metrics.width || '-'}×{metrics.height || '-'}
      </dd>

      <dt>fps</dt>
      <dd className={metrics.fps && metrics.fps < 45 ? 'warn' : ''}>{metrics.fps || '-'}</dd>

      <dt>bitrate</dt>
      <dd>{mbps} Mb/s</dd>

      <dt>codec</dt>
      <dd>{metrics.codec}</dd>

      <dt>rtt</dt>
      <dd className={level(metrics.rttMs, 60, 120)}>{metrics.rttMs} ms</dd>

      <dt>perda</dt>
      <dd className={level(metrics.lossPct, 1, 3)}>{metrics.lossPct}%</dd>

      <dt>jitter</dt>
      <dd className={level(metrics.jitterMs, 20, 50)}>{metrics.jitterMs} ms</dd>

      {side === 'out' ? (
        <>
          <dt>limite</dt>
          <dd className={metrics.limitation !== 'none' ? 'warn' : ''}>{metrics.limitation}</dd>
          <dt>encoder</dt>
          <dd>{metrics.impl}</dd>
        </>
      ) : (
        <>
          <dt>buffer</dt>
          <dd className={level(metrics.bufferMs, 80, 200)}>{metrics.bufferMs} ms</dd>
          <dt>travadas</dt>
          <dd className={metrics.freezes > 0 ? 'warn' : ''}>{metrics.freezes}</dd>
          <dt>decoder</dt>
          <dd>{metrics.impl}</dd>
        </>
      )}
    </dl>
  );
}
