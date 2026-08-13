const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `http_${response.status}`);
  return body;
}

export const api = {
  rooms: () => request('/api/call/v1/rooms', { headers: { Accept: 'application/json' } }),
  createRoom: (name) => request('/api/call/v1/rooms', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }) }),
  closeRoom: (id) => request(`/api/call/v1/rooms/${id}`, { method: 'DELETE', headers: { Accept: 'application/json' } }),
  issueToken: (id, capabilities) => request(`/api/call/v1/rooms/${id}/tokens`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(capabilities) }),
  ownerJoin: (id) => request(`/api/call/v1/rooms/${id}/join`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ client_kind: 'web' }) }),
  guestJoin: (token, displayName) => request(`/api/call/v1/join/${encodeURIComponent(token)}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ display_name: displayName, client_kind: 'web' }) }),
};
