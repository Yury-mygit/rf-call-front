export function route() {
  const guest = location.pathname.match(/^\/j\/([^/]+)$/);
  if (guest) return { name: 'guest', token: decodeURIComponent(guest[1]) };
  const room = location.pathname.match(/^\/room\/([^/]+)$/);
  if (room) return { name: 'room', roomId: room[1] };
  return { name: 'owner' };
}

export function navigate(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
