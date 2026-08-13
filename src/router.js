export function route() {
  const guest = location.pathname.match(/^\/j\/([^/]+)$/);
  if (guest) return { name: 'guest', token: decodeURIComponent(guest[1]) };
  const room = location.pathname.match(/^\/room\/([^/]+)$/);
  if (room) return { name: 'room', roomId: room[1] };
  return { name: 'owner' };
}

export function navigate(path, { replace = false, state = {} } = {}) {
  history[replace ? 'replaceState' : 'pushState'](state, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
