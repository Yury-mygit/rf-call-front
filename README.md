# rf-call-front

Frontend SPA for CALL — веб-инструмент для видеосвязи со screen share.

Hosted on `call.dev.raftforge.art`. Owner использует через iframe в
landing shell (`raftforge.art/call/*`); гость открывает напрямую по
ссылке `call.dev.raftforge.art/j/{token}`.

Стек: vite@6, vanilla JS (ESM). Dev-server — systemd `vite-call-dev`
на `127.0.0.1:5189`, за Caddy.

Epic: CL-2 (tasks-dev). Sub-story: CL-6.

## Dev

```sh
npm install
npm run dev      # локально
# в prod-режиме сервера:
systemctl status vite-call-dev
```
