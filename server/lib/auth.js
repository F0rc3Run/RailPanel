import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { load, update } from './store.js';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'rp_session';

/* Sessions live in memory only: a restart signs everyone out, which is the
   behaviour we want for a panel that hands out proxy credentials. */
const sessions = new Map();

export function hash(password, salt) {
  return scryptSync(password, salt, 64, SCRYPT).toString('base64');
}

/* The key that unlocks stored secrets. Derived from the password, never
   written down, and held only for the life of a session. */
function deriveKek(password, salt) {
  return scryptSync(password, salt + ':kek', 32, SCRYPT);
}

export function setCredentials(user, password) {
  const salt = randomBytes(16).toString('base64');
  return update(data => {
    data.admin = { user, salt, hash: hash(password, salt) };
    return data.admin;
  });
}

export function hasAdmin() {
  return Boolean(load().admin);
}

function sameSecret(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* ---- login throttling, per source address ---- */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

export function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

export function signIn(user, password, ip) {
  const admin = load().admin;
  if (!admin) return null;

  const userOk = sameSecret(user, admin.user);
  const passOk = sameSecret(hash(password, admin.salt), admin.hash);
  // Both checks always run, so a wrong username and a wrong password
  // take the same amount of time.
  if (!userOk || !passOk) { noteFailure(ip); return null; }

  attempts.delete(ip);
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, {
    user: admin.user,
    kek: deriveKek(password, admin.salt),
    expires: Date.now() + SESSION_TTL_MS
  });
  return token;
}

/* The key that unlocks stored secrets, for the moment right after a sign-in
   when the caller still needs it and has only the token in hand. */
export function kekFor(token) {
  return sessions.get(token)?.kek || null;
}

export function sessionOf(req) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';')
    .map(part => part.trim().split('='))
    .find(([name]) => name === COOKIE);
  if (!found) return null;

  const session = sessions.get(found[1]);
  if (!session) return null;
  if (Date.now() > session.expires) { sessions.delete(found[1]); return null; }
  return session;
}

export function signOut(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) sessions.delete(value);
  }
}

export function cookieHeader(token, secure) {
  const bits = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookieHeader() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/* Changing the password re-derives the key, so anything sealed under the
   old one has to be resealed by the caller before the change lands. */
export function rederive(password, salt) {
  return deriveKek(password, salt);
}

export function fingerprintOf(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
