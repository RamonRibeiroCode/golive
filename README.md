# golive

Compartilhamento de tela P2P via WebRTC, ajustado para transmitir jogos com fluidez.
Uma pessoa compartilha, a outra assiste. O vídeo vai direto de um navegador para o
outro — o servidor só apresenta os dois.

## Rodando

```bash
npm install
```

```bash
npm run dev
```

Abra `http://localhost:3000`, escolha um código de sala e clique em **Compartilhar**.
Quem for assistir abre a mesma sala em **Assistir** (ou o link do botão *copiar link*).

### Assistindo de outro dispositivo

WebRTC só funciona em contexto seguro. `localhost` conta como seguro, mas o IP da
rede local não — então para assistir de outro PC/celular use HTTPS:

```bash
npm run dev:https
```

Um certificado autoassinado é gerado em `.certs/` na primeira execução (já com o IP
da sua rede no SAN). O navegador vai avisar que o certificado é desconhecido;
aceite o aviso nos dois lados.

### Produção

```bash
npm run build
```

```bash
npm run start
```

## Configurações de encoder

Tudo fica na barra inferior da página de quem transmite:

| Controle | Padrão | Observação |
| --- | --- | --- |
| bitrate | 12 Mb/s | 1–50. Muda ao vivo, sem reconectar |
| fps | 60 | Muda ao vivo |
| resolução | 1080p | Limite superior; o encoder reduz sozinho se faltar banda |
| codec | auto (h264) | Troca exige uma renegociação rápida |
| áudio do sistema | ligado | Só pode ser alterado antes de começar |

Referência rápida de bitrate: **8–12 Mb/s** para 1080p60 na rede local,
**20–35 Mb/s** para 1440p/4K, **4–6 Mb/s** se a rede for apertada.

### O que está ajustado por baixo

- **`contentHint = 'motion'`** na trilha de vídeo. É o ajuste que mais importa: diz
  ao encoder que a cena é movimento contínuo, não texto parado, então ele prefere
  manter os quadros a manter os detalhes.
- **`degradationPreference = 'maintain-framerate'`**. Quando a banda aperta o
  padrão do WebRTC é derrubar fps; aqui ele derruba resolução e segura os 60fps.
- **Start bitrate alto** (`x-google-start-bitrate`, 70% do máximo) injetado no SDP.
  Sem isso o libwebrtc começa em ~300 kb/s e leva dezenas de segundos para subir —
  os primeiros segundos da transmissão ficam borrados.
- **H.264 High profile com `packetization-mode=1`** priorizado na lista de codecs.
  É o caminho que usa o encoder da GPU: menor latência e CPU livre para o jogo.
  AV1 e VP9 rendem imagem melhor por bit, mas caem em software e não sustentam
  1080p60 na maioria das máquinas — por isso aparecem marcados como *pesado*.
- **Áudio sem processamento**: cancelamento de eco, supressão de ruído e ganho
  automático desligados, opus em estéreo a 192 kb/s. Os dois lados anunciam
  `stereo=1` — se só o transmissor anunciar, o opus manda mono.
- **Jitter buffer mínimo** no lado de quem assiste (`jitterBufferTarget = 0`), para
  a imagem acompanhar o jogo em vez de ficar atrasada.
- `max-bundle` + `rtcp-mux` e um pool de candidatos ICE, para a conexão fechar rápido.

### Diagnóstico

Quem transmite vê fps, bitrate, codec, RTT, perda e o motivo de qualquer degradação
(`limite: cpu` ou `limite: bandwidth`) assim que houver alguém assistindo.
Quem assiste vê o mesmo pelo botão **stats**, mais o buffer e a contagem de travadas.

Se `limite` mostrar `cpu`, baixe a resolução ou troque para h264. Se mostrar
`bandwidth`, baixe o bitrate.

## Fora da rede local

STUN resolve a maioria dos casos em rede local e boa parte das conexões domésticas.
Para NATs simétricos é preciso um TURN:

```bash
TURN_URL=turn:seu-servidor:3478 TURN_USERNAME=user TURN_CREDENTIAL=senha npm run start
```

## Estrutura

```
server.mjs                    Next + sinalização WebSocket no mesmo processo
lib/webrtc.ts                 constraints, codecs, parâmetros do encoder, SDP
lib/signaling.ts              cliente WebSocket
lib/stats.ts                  leitura de getStats()
app/page.tsx                  entrada da sala
app/host/[room]/page.tsx      quem transmite (uma conexão por espectador)
app/watch/[room]/page.tsx     quem assiste
app/api/ice/route.ts          STUN/TURN
```

A sinalização é só isso: o servidor guarda `sala -> { host, espectadores }` em
memória e repassa offer/answer/candidatos. Nenhum vídeo passa por ele.
