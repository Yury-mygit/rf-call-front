# rf-call-front

Frontend SPA for CALL — веб-инструмент для видеосвязи со screen share.

Hosted on `call.dev.raftforge.art`. Owner использует через iframe в
landing shell (`raftforge.art/call/*`); гость открывает напрямую по
ссылке `call.dev.raftforge.art/j/{token}`.

Стек: vite@6, vanilla JS (ESM). Dev-server — systemd `vite-call-dev`
на `127.0.0.1:5189`, за Caddy.

Epic: CL-2 (tasks-dev). Sub-story: CL-6.

## Browser smoke status

Partial two-client smoke completed on 2026-08-13:

- owner and guest join the same room;
- microphone mute/unmute and screen share work;
- room close revokes links and removes the room from the active list;
- media uses coturn relay (`iceTransportPolicy: relay`) for predictable NAT
  traversal;
- local microphone tracks are never rendered locally, preventing
  self-monitoring and acoustic echo loops.

LiveKit Server 1.13.5 is used with `livekit-client` 2.21.x. The previous
server 1.7.2 repeatedly dropped peer connections during media
renegotiation.

CL-6 Stage 2.9 remains open until the repeat Chrome/Firefox/Safari and mobile
viewport smoke is complete.

## Exclusive screen share (CL-15)

- Media stage is hidden until a screen-share track exists; room label,
  participant cards and controls remain available.
- Stage opens and closes with a CRT-style transition and respects
  `prefers-reduced-motion`.
- The stage follows the captured track's actual video aspect ratio, including
  portrait phone screens, without stretching.
- A backend atomic claim permits one screen publisher at a time. Other clients
  disable their share button until stop, leave or disconnect releases it.
- The publisher keeps a local preview. Capturing an entire monitor that also
  displays CALL necessarily creates a mirror corridor; share a specific
  window/tab or move the viewer to another monitor to avoid it.

## Dev

```sh
npm install
npm run dev      # локально
# в prod-режиме сервера:
systemctl status vite-call-dev
```
