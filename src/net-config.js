// Online play: Firebase Realtime Database URL used only to exchange the WebRTC handshake
// (room code -> connection offer/answer). Game traffic itself goes browser-to-browser.
// Paste your database URL here, e.g. 'https://bender-sand-default-rtdb.firebaseio.com'.
// (This is public client config, not a secret. Lock it down with the rules in ONLINE.md.)
export const FIREBASE_DB_URL = 'https://bender-sand-default-rtdb.asia-southeast1.firebasedatabase.app';

// Free public STUN servers so browsers can find a route to each other.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// `?db=<url>` overrides the database (used for local testing).
export function dbUrl() {
  const q = new URLSearchParams(window.location.search).get('db');
  return (q || FIREBASE_DB_URL).replace(/\/$/, '');
}
