const shellOrigin = 'https://raftforge.art';
export const embedded = window.parent !== window;

export function emit(type, payload = {}) {
  if (embedded) window.parent.postMessage({ source: 'call', version: 1, type, payload }, shellOrigin);
}

export function listen(handler) {
  addEventListener('message', (event) => {
    if (event.origin !== shellOrigin || event.source !== window.parent) return;
    const message = event.data;
    if (message?.source !== 'shell' || message?.version !== 1) return;
    handler(message.type, message.payload || {});
  });
  emit('shell.identity_request');
}
