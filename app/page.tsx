'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => ALPHABET[n % ALPHABET.length]).join('');

export default function Home() {
  const router = useRouter();
  const [room, setRoom] = useState('');

  useEffect(() => setRoom(newCode()), []);

  const go = (role: 'host' | 'watch') => {
    const code = room.trim().toUpperCase();
    if (code) router.push(`/${role}/${encodeURIComponent(code)}`);
  };

  return (
    <main className="home">
      <div className="card">
        <h1 className="logo">
          go<span>live</span>
        </h1>
        <p className="sub">Tela em tempo real, direto entre os dois navegadores.</p>

        <label className="field" htmlFor="room">
          Código da sala
        </label>
        <div className="row">
          <input
            id="room"
            value={room}
            maxLength={16}
            onChange={(e) => setRoom(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && go('host')}
            autoComplete="off"
            spellCheck={false}
          />
          <button onClick={() => setRoom(newCode())} title="Gerar outro código">
            ↻
          </button>
        </div>

        <div className="actions">
          <button className="primary" onClick={() => go('host')} disabled={!room.trim()}>
            Compartilhar
          </button>
          <button onClick={() => go('watch')} disabled={!room.trim()}>
            Assistir
          </button>
        </div>
      </div>
    </main>
  );
}
