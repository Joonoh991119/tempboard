const H = { "Content-Type": "application/json", "X-Whiteboard": "1" };

async function req(method, url, body, signal) {
  const r = await fetch(url, { method, headers: body ? H : { "X-Whiteboard": "1" }, credentials: "same-origin", body: body ? JSON.stringify(body) : undefined, signal });
  if (r.status === 204) return null;
  const t = await r.text();
  const d = t ? JSON.parse(t) : null;
  if (!r.ok) { const e = new Error((d && d.error) || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return d;
}

export const api = {
  me: () => req("GET", "/api/whiteboard/me"),
  login: (name) => req("POST", "/api/whiteboard/login", { name }),
  boards: () => req("GET", "/api/whiteboard/boards"),
  create: (title) => req("POST", "/api/whiteboard/boards", { title }),
  board: (id) => req("GET", `/api/whiteboard/boards/${id}`),
  rename: (id, title) => req("POST", `/api/whiteboard/boards/${id}/title`, { title }),
  push: (id, client, elements) => req("POST", `/api/whiteboard/boards/${id}/elements`, { client, elements }),
  presence: (id, client, p) => req("POST", `/api/whiteboard/boards/${id}/presence`, { client, ...p }),
  putFile: (id, client, f) => req("POST", `/api/whiteboard/boards/${id}/files`, { client, id: f.id, mimeType: f.mimeType, dataURL: f.dataURL }),
  getFile: (id, fid) => req("GET", `/api/whiteboard/boards/${id}/files/${fid}`),
  poll: (id, client, since, pver, epoch, signal, saved = -1) => req("GET", `/api/whiteboard/boards/${id}/poll?client=${encodeURIComponent(client)}&since=${since}&pver=${pver}&saved=${saved}&epoch=${encodeURIComponent(epoch || "")}`, undefined, signal),
  events: (id, client) => new EventSource(`/api/whiteboard/boards/${id}/events?client=${encodeURIComponent(client)}`, { withCredentials: true }),
};
