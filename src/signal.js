// Room-code signaling over the Firebase Realtime Database REST API (no SDK).
//   rooms/<CODE>            { open, created }
//   rooms/<CODE>/joins/<id> { name, offer }   written by a joiner
//   rooms/<CODE>/joins/<id>/answer            written by the host
// Joiners create the WebRTC offer, the host answers. ICE candidates are gathered up front
// (non-trickle), so each side writes exactly one message.
import { dbUrl, ICE_SERVERS, TURN_SERVERS } from './net-config.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, method = 'GET', body) {
  const res = await fetch(`${dbUrl()}/${path}.json`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`signaling ${method} ${res.status}`);
  return res.json();
}

export const onlineConfigured = () => !!dbUrl();

export function newPeerConnection() {
  return new RTCPeerConnection({ iceServers: [...ICE_SERVERS, ...TURN_SERVERS] });
}

// Resolve once ICE gathering is complete (or after `ms`, using whatever was found).
function gathered(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ms);
  });
}

// ---------- host ----------
// Opens a room and calls onPeer(pc, name, id) for every joiner, once its answer is sent.
export async function hostRoom(onPeer) {
  let code;
  for (let tries = 0; tries < 8; tries++) {
    code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
    if (!(await rest(`rooms/${code}`))) break;
  }
  await rest(`rooms/${code}`, 'PUT', { open: true, created: Date.now() });

  const handled = new Set();
  const handle = async (id, join) => {
    if (handled.has(id) || !join || !join.offer || join.answer) return;
    handled.add(id);
    const pc = newPeerConnection();
    await pc.setRemoteDescription({ type: 'offer', sdp: join.offer });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    await rest(`rooms/${code}/joins/${id}/answer`, 'PUT', pc.localDescription.sdp);
    onPeer(pc, String(join.name || 'Guest').slice(0, 12), id);
  };

  // Live stream of rooms/<code>/joins (Firebase REST streaming = server-sent events).
  const es = new EventSource(`${dbUrl()}/rooms/${code}/joins.json`);
  const onEvent = (e) => {
    const { path, data } = JSON.parse(e.data);
    if (!data) return;
    if (path === '/') { for (const [id, j] of Object.entries(data)) handle(id, j).catch(console.warn); }
    else {
      const id = path.split('/')[1];
      if (path.split('/').length === 2) handle(id, data).catch(console.warn);
    }
  };
  es.addEventListener('put', onEvent);
  es.addEventListener('patch', onEvent);

  return {
    code,
    lock: () => rest(`rooms/${code}/open`, 'PUT', false).catch(() => {}),
    unlock: () => rest(`rooms/${code}/open`, 'PUT', true).catch(() => {}),
    close: () => { es.close(); rest(`rooms/${code}`, 'DELETE').catch(() => {}); },
  };
}

// ---------- joiner ----------
// Returns { pc, ctl, snap } once both data channels are open. Throws a readable Error otherwise.
// status(text): progress for the join screen.
export async function joinRoom(code, name, status = () => {}) {
  code = code.trim().toUpperCase();
  status('finding room...');
  const room = await rest(`rooms/${code}`);
  if (!room) throw new Error(`No room "${code}"`);
  if (!room.open) throw new Error('That match has already started');

  const pc = newPeerConnection();
  const ctl = pc.createDataChannel('ctl', { ordered: true });
  const snap = pc.createDataChannel('snap', { ordered: true });
  ctl.binaryType = snap.binaryType = 'arraybuffer';
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);

  const id = Math.random().toString(36).slice(2, 10);
  status('waiting for the host to answer...');
  await rest(`rooms/${code}/joins/${id}`, 'PUT', { name, offer: pc.localDescription.sdp });

  let answer = null;
  for (let t = 0; t < 40 && !answer; t++) { await sleep(750); answer = await rest(`rooms/${code}/joins/${id}/answer`); }
  if (!answer) { pc.close(); rest(`rooms/${code}/joins/${id}`, 'DELETE').catch(() => {}); throw new Error('The host did not answer (is their game still open on the lobby?)'); }
  status(TURN_SERVERS.length ? 'connecting (direct or via relay)...' : 'connecting directly to the host...');
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  const blocked = TURN_SERVERS.length
    ? 'Could not connect to the host, even through the relay. Check the TURN settings in src/net-config.js.'
    : 'Your network blocks direct connections to the host. A TURN relay is needed (see ONLINE.md), or try both players on the same Wi-Fi.';
  const open = (ch) => new Promise((resolve, reject) => {
    if (ch.readyState === 'open') return resolve();
    ch.onopen = () => resolve();
    pc.addEventListener('iceconnectionstatechange', () => { if (pc.iceConnectionState === 'failed') reject(new Error(blocked)); });
    setTimeout(() => reject(new Error(blocked)), 15000);
  });
  try { await Promise.all([open(ctl), open(snap)]); }
  finally { rest(`rooms/${code}/joins/${id}`, 'DELETE').catch(() => {}); }
  return { pc, ctl, snap };
}
