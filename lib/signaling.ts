export type ServerMessage =
  | { type: 'joined'; id: string }
  | { type: 'peer-join'; id: string }
  | { type: 'peer-left'; id: string }
  | { type: 'host-ready' }
  | { type: 'host-left' }
  | { type: 'no-host' }
  | { type: 'viewers'; count: number }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'error'; message: string };

export type Signaling = {
  send: (msg: unknown) => void;
  close: () => void;
};

export function connect(
  room: string,
  role: 'host' | 'viewer',
  handlers: {
    onMessage: (msg: ServerMessage) => void;
    onOpen?: () => void;
    onClose?: () => void;
  },
): Signaling {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  let closed = false;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room, role }));
    handlers.onOpen?.();
  };
  ws.onmessage = (event) => {
    try {
      handlers.onMessage(JSON.parse(event.data) as ServerMessage);
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onclose = () => {
    if (!closed) handlers.onClose?.();
  };

  return {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => {
      closed = true;
      ws.close();
    },
  };
}
