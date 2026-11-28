const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const createSocialRouter = require('./collaboration');

// =====================================================================
// 設定(環境変数)
// =====================================================================
const REQUIRED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_USER', 'ADMIN_PASSWORD'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error('環境変数が設定されていません: ' + missingEnv.join(', '));
  process.exit(1);
}
const { DATABASE_URL, SESSION_SECRET, ADMIN_USER, ADMIN_PASSWORD } = process.env;
if (SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET は32文字以上にしてください');
  process.exit(1);
}
const ADMIN_PATH = process.env.ADMIN_PATH || 'admin';
const RESERVED_PATHS = ['login', 'logout', 'search', 'search-api', 'search-thumb', 'player', 'static', 'js', 'extensions', 'my', 'me', 'editor', 'logo', 'feedback'];
if (!/^[A-Za-z0-9_-]{1,64}$/.test(ADMIN_PATH) || RESERVED_PATHS.includes(ADMIN_PATH)) {
  console.error('ADMIN_PATH は半角英数字・_・- の1〜64文字で、他のページ名と重ならない値にしてください');
  process.exit(1);
}
const SEARCH_LANGUAGE = process.env.SEARCH_LANGUAGE || 'ja';
// 「私の作品」: 1アカウントあたりの保存数と、1作品の大きさの上限
const MAX_PROJECTS = Math.max(1, Number.parseInt(process.env.MAX_PROJECTS, 10) || 5);
const MAX_PROJECT_MB = Math.max(1, Number.parseInt(process.env.MAX_PROJECT_MB, 10) || 15);
const MAX_PROJECT_BYTES = MAX_PROJECT_MB * 1024 * 1024;

const USER_COOKIE = 'mirror_session';
const ADMIN_COOKIE = 'mirror_admin';
const USER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const LOG_RETENTION_DAYS = 180;

// =====================================================================
// データベース
// =====================================================================
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});
pool.on('error', (err) => console.error('DB pool error:', err.message));
const q = (text, params) => pool.query(text, params);

const initDb = async () => {
  await q(`CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ver INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login TIMESTAMPTZ
  )`);
  await q('CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower ON accounts (lower(username))');
  await q('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE');
  await q(`CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    username TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT,
    ip TEXT,
    ua TEXT
  )`);
  await q('CREATE INDEX IF NOT EXISTS logs_at ON logs (at DESC)');
  await q('CREATE INDEX IF NOT EXISTS logs_username ON logs (lower(username))');
  await q(`CREATE TABLE IF NOT EXISTS projects (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    data BYTEA NOT NULL,
    size INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q('CREATE INDEX IF NOT EXISTS projects_account ON projects (account_id)');
  await q(`CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q('CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at DESC)');
  await createSocialRouter.createSchema(q);
};

const cleanupLogs = async () => {
  await q('DELETE FROM logs WHERE at < NOW() - ($1 || \' days\')::interval', [String(LOG_RETENTION_DAYS)]);
};

const logEvent = async (username, event, req, detail) => {
  try {
    await q(
      'INSERT INTO logs (username, event, detail, ip, ua) VALUES ($1, $2, $3, $4, $5)',
      [
        String(username).slice(0, 64),
        event,
        detail ? String(detail).slice(0, 200) : null,
        req ? String(req.ip || '').slice(0, 64) : null,
        req ? String(req.headers['user-agent'] || '').slice(0, 200) : null
      ]
    );
  } catch (err) {
    console.error('ログの保存に失敗しました:', err.message);
  }
};

// =====================================================================
// パスワードのハッシュ・署名つきCookie
// =====================================================================
const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
});
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return salt.toString('hex') + ':' + key.toString('hex');
};
const verifyPassword = async (password, stored) => {
  const [saltHex, keyHex] = String(stored).split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};
let DUMMY_HASH = null; // 存在しないアカウント名でも、同じ時間をかけて照合するため

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(String(a)), sha(String(b)));
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');

const makeUserToken = (id, ver) => {
  const body = 'u.' + id + '.' + ver + '.' + (Date.now() + USER_MAX_AGE_MS);
  return body + '.' + hmac(body);
};
const parseUserToken = (token) => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'u') return null;
  if (!safeEqual(parts[4], hmac(parts.slice(0, 4).join('.')))) return null;
  const id = Number(parts[1]);
  const ver = Number(parts[2]);
  const exp = Number(parts[3]);
  if (!Number.isInteger(id) || !Number.isInteger(ver) || !(exp > Date.now())) return null;
  return { id, ver };
};
const makeAdminToken = () => {
  const body = 'a.' + (Date.now() + ADMIN_MAX_AGE_MS);
  return body + '.' + hmac(body);
};
const verifyAdminToken = (token) => {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'a') return false;
  if (!safeEqual(parts[2], hmac(parts.slice(0, 2).join('.')))) return false;
  return Number(parts[1]) > Date.now();
};

const getCookie = (req, name) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch (e) {
      return null;
    }
  }
  return null;
};

// =====================================================================
// アカウントの状態(メモリ上のキャッシュ)
// 管理画面での無効化・削除を、すぐにログイン中の利用者へ反映するために使う
// =====================================================================
let accountCache = new Map();
const refreshAccounts = async () => {
  const { rows } = await q('SELECT id, username, enabled, ver, is_admin FROM accounts');
  accountCache = new Map(rows.map((r) => [r.id, r]));
};
const getLoggedInUser = (req) => {
  const p = parseUserToken(getCookie(req, USER_COOKIE));
  if (!p) return null;
  const acc = accountCache.get(p.id);
  if (!acc || !acc.enabled || acc.ver !== p.ver) return null;
  return acc;
};

// =====================================================================
// ログイン失敗の回数制限(メモリ上。再起動で消える)
// =====================================================================
const makeLimiter = (limit, windowMs) => {
  const map = new Map();
  return {
    blocked(ip) {
      const e = map.get(ip);
      if (!e) return false;
      if (e.resetAt < Date.now()) {
        map.delete(ip);
        return false;
      }
      return e.count >= limit;
    },
    fail(ip) {
      if (map.size > 5000) map.clear();
      const now = Date.now();
      const e = map.get(ip);
      if (!e || e.resetAt < now) map.set(ip, { count: 1, resetAt: now + windowMs });
      else e.count++;
    },
    clear(ip) {
      map.delete(ip);
    }
  };
};
const userLimiter = makeLimiter(5, 10 * 60 * 1000);
const adminLimiter = makeLimiter(5, 10 * 60 * 1000);

// =====================================================================
// ログインページ
// =====================================================================
const loginPage = (message = '') => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>ログイン</title>
<style>
  :root { --accent: #FF4C4C; color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
         justify-content: center; gap: 32px; padding: 24px; box-sizing: border-box;
         font-family: system-ui, sans-serif; background: #f3f4f6; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111827; color: #f3f4f6; } }
  .logo { display: block; width: min(720px, 90vw); height: auto; }
  form { width: min(320px, 90vw); padding: 24px; border-radius: 12px; background: rgba(127,127,127,.15); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; }
  input, button { width: 100%; box-sizing: border-box; padding: 10px; font-size: 16px; border-radius: 8px; border: 1px solid #888; }
  input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
  button { margin-top: 16px; border: 0; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; }
  button:hover { filter: brightness(0.92); }
  button:disabled { opacity: .6; cursor: default; }
  #msg { min-height: 1.5em; margin: 12px 0 0; color: #b00020; font-size: 14px; }
  .note { margin: 8px 0 0; font-size: 13px; text-align: center; opacity: .85; }
</style>
</head>
<body>
<img class="logo" src="/logo.png" alt="TURBOWARP">
<form id="f" method="post" action="/login">
  <h1>ログイン</h1>
  <label for="u">アカウント名</label>
  <input id="u" type="text" name="username" autofocus required maxlength="64" autocomplete="username" autocapitalize="off" spellcheck="false">
  <label for="p">パスワード</label>
  <input id="p" type="password" name="password" required maxlength="256" autocomplete="current-password">
  <button id="b" type="submit">ログイン</button>
  <p id="msg">${message}</p>
  <p class="note">アカウントをお持ちではないですか?管理者に連絡してください!</p>
</form>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msg');
    const btn = document.getElementById('b');
    msg.textContent = '';
    btn.disabled = true;
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams(new FormData(e.target))
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) { location.reload(); return; }
      msg.textContent = data.message || 'ログインに失敗しました';
    } catch (err) {
      msg.textContent = '通信に失敗しました';
    }
    btn.disabled = false;
  });
</script>
</body>
</html>`;

// =====================================================================
// アプリ本体
// =====================================================================
const app = express();
app.set('trust proxy', 1);
app.set('x-powered-by', false);

// ログイン前のページでも表示するロゴ
app.get('/logo.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'logo.png'));
});

// ---- 利用者のログイン / ログアウト ----
const BAD_LOGIN = 'アカウント名またはパスワードが違います';

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = req.ip;
  const wantsJson = (req.headers.accept || '').includes('application/json');
  const reply = (status, ok, message) => {
    if (wantsJson) return res.status(status).json({ ok, message });
    if (ok) return res.redirect('/');
    return res.status(status).type('html').send(loginPage(message));
  };

  if (userLimiter.blocked(ip)) {
    return reply(429, false, '失敗が続いたため、しばらくしてからやり直してください');
  }

  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
  const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
  if (!username || !password) return reply(401, false, BAD_LOGIN);

  // 管理者のユーザー名・パスワードでも、そのままログインできる(管理者用のアカウントを自動で作る)
  const isAdminLogin = safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASSWORD);
  if (isAdminLogin) {
    // 通常のパスワードでは入れない(使えない値を設定する)。管理者のユーザー名・パスワードだけで入れる
    await q(
      'INSERT INTO accounts (username, pass_hash) VALUES ($1, $2) ON CONFLICT (lower(username)) DO NOTHING',
      [ADMIN_USER, await hashPassword(crypto.randomBytes(24).toString('hex'))]
    );
    await q('UPDATE accounts SET is_admin = TRUE WHERE lower(username) = lower($1) AND NOT is_admin', [ADMIN_USER]);
    await refreshAccounts();
  }

  const { rows } = await q(
    'SELECT id, username, pass_hash, enabled, ver FROM accounts WHERE lower(username) = lower($1)',
    [isAdminLogin ? ADMIN_USER : username]
  );
  const acc = rows[0];
  const passwordOk = isAdminLogin || await verifyPassword(password, acc ? acc.pass_hash : DUMMY_HASH);

  if (!acc || !passwordOk) {
    userLimiter.fail(ip);
    await logEvent(username, 'login_failed', req);
    return reply(401, false, BAD_LOGIN);
  }
  if (!acc.enabled) {
    await logEvent(acc.username, 'login_blocked', req, '無効化されたアカウント');
    return reply(403, false, 'このアカウントは無効になっています。管理者に連絡してください');
  }

  userLimiter.clear(ip);
  await q('UPDATE accounts SET last_login = NOW() WHERE id = $1', [acc.id]);
  await logEvent(acc.username, 'login_success', req);
  res.cookie(USER_COOKIE, makeUserToken(acc.id, acc.ver), {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: USER_MAX_AGE_MS,
    path: '/'
  });
  return reply(200, true, '');
});

app.get('/logout', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const p = parseUserToken(getCookie(req, USER_COOKIE));
  const acc = p ? accountCache.get(p.id) : null;
  if (acc) await logEvent(acc.username, 'logout', req);
  res.clearCookie(USER_COOKIE, { path: '/' });
  res.redirect('/');
});

// ---- 管理画面(利用者のログインとは別の認証) ----
const admin = express.Router();
admin.use(express.json({ limit: '4kb' }));

admin.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

admin.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

admin.post('/api/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = req.ip;
  if (adminLimiter.blocked(ip)) {
    return res.status(429).json({ error: 'rate_limited', message: '失敗が続いたため、しばらくしてからやり直してください' });
  }
  const body = req.body || {};
  const okUser = safeEqual(typeof body.username === 'string' ? body.username : '', ADMIN_USER);
  const okPass = safeEqual(typeof body.password === 'string' ? body.password : '', ADMIN_PASSWORD);
  if (!(okUser && okPass)) {
    adminLimiter.fail(ip);
    await logEvent(typeof body.username === 'string' ? body.username : '', 'admin_login_failed', req);
    return res.status(401).json({ error: 'bad_credentials', message: '管理者のユーザー名またはパスワードが違います' });
  }
  adminLimiter.clear(ip);
  await logEvent(ADMIN_USER, 'admin_login', req);
  res.cookie(ADMIN_COOKIE, makeAdminToken(), {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    maxAge: ADMIN_MAX_AGE_MS,
    path: '/' + ADMIN_PATH
  });
  return res.json({ ok: true });
});

// 管理者権限を付与されたアカウントでログイン中なら、管理画面のログインなしで操作できる
const isAdminAccountRequest = (req) => {
  const acc = getLoggedInUser(req);
  return !!(acc && acc.is_admin);
};
const requireAdmin = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!verifyAdminToken(getCookie(req, ADMIN_COOKIE)) && !isAdminAccountRequest(req)) {
    return res.status(401).json({ error: 'unauthorized', message: 'ログインしてください' });
  }
  // 画面以外(他サイトのフォームなど)からの変更操作を拒否する
  if (req.method !== 'GET' && req.get('X-Admin') !== '1') {
    return res.status(403).json({ error: 'forbidden', message: '許可されていない操作です' });
  }
  return next();
};
admin.use('/api', requireAdmin);

admin.post('/api/logout', async (req, res) => {
  await logEvent(ADMIN_USER, 'admin_logout', req);
  res.clearCookie(ADMIN_COOKIE, { path: '/' + ADMIN_PATH });
  res.json({ ok: true });
});

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128;
const parseId = (v) => {
  const id = Number.parseInt(v, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

admin.get('/api/accounts', async (req, res) => {
  const { rows } = await q('SELECT id, username, enabled, is_admin, created_at, last_login FROM accounts ORDER BY id');
  res.json(rows);
});

admin.post('/api/accounts', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'bad_username', message: 'アカウント名は、半角英数字と _ . - の3〜32文字にしてください' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'bad_password', message: 'パスワードは8〜128文字にしてください' });
  }
  const passHash = await hashPassword(password);
  try {
    const { rows } = await q('INSERT INTO accounts (username, pass_hash) VALUES ($1, $2) RETURNING id', [username, passHash]);
    await refreshAccounts();
    await logEvent(username, 'account_created', req, '管理者による操作');
    return res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'duplicate', message: 'そのアカウント名は、すでに使われています' });
    }
    throw err;
  }
});

admin.post('/api/accounts/:id/enabled', async (req, res) => {
  const id = parseId(req.params.id);
  const enabled = req.body ? req.body.enabled : undefined;
  if (!id || typeof enabled !== 'boolean') return res.status(400).json({ error: 'bad_request', message: '指定が正しくありません' });
  // 無効化するときは ver を上げて、ログイン中のセッションを無効にする(再度有効にしても、再ログインが必要)
  const { rows } = await q(
    'UPDATE accounts SET enabled = $2::boolean, ver = CASE WHEN $2::boolean THEN ver ELSE ver + 1 END WHERE id = $1 RETURNING username',
    [id, enabled]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'アカウントが見つかりません' });
  await refreshAccounts();
  await logEvent(rows[0].username, enabled ? 'account_enabled' : 'account_disabled', req, '管理者による操作');
  return res.json({ ok: true });
});

// 管理者権限の付与・解除は、管理者のユーザー名・パスワードで入った人(管理画面のログイン)だけができる
// (権限を付けられたアカウントが、さらに他の人へ権限を広げられないようにするため)
admin.post('/api/accounts/:id/admin', async (req, res) => {
  if (!verifyAdminToken(getCookie(req, ADMIN_COOKIE))) {
    return res.status(403).json({ error: 'forbidden', message: '管理者権限の付与・解除は、管理者のユーザー名とパスワードで管理画面にログインしたときだけできます' });
  }
  const id = parseId(req.params.id);
  const isAdmin = req.body ? req.body.admin : undefined;
  if (!id || typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'bad_request', message: '指定が正しくありません' });
  const { rows } = await q('UPDATE accounts SET is_admin = $2::boolean WHERE id = $1 RETURNING username', [id, isAdmin]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'アカウントが見つかりません' });
  await refreshAccounts();
  await logEvent(rows[0].username, isAdmin ? 'admin_granted' : 'admin_revoked', req, '管理者による操作');
  return res.json({ ok: true });
});

admin.post('/api/accounts/:id/password', async (req, res) => {
  const id = parseId(req.params.id);
  const password = req.body ? req.body.password : undefined;
  if (!id) return res.status(400).json({ error: 'bad_request', message: '指定が正しくありません' });
  if (!validPassword(password)) return res.status(400).json({ error: 'bad_password', message: 'パスワードは8〜128文字にしてください' });
  const passHash = await hashPassword(password);
  const { rows } = await q('UPDATE accounts SET pass_hash = $2, ver = ver + 1 WHERE id = $1 RETURNING username', [id, passHash]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'アカウントが見つかりません' });
  await refreshAccounts();
  await logEvent(rows[0].username, 'password_reset', req, '管理者による操作');
  return res.json({ ok: true });
});

admin.delete('/api/accounts/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request', message: '指定が正しくありません' });
  const { rows } = await q('DELETE FROM accounts WHERE id = $1 RETURNING username', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'アカウントが見つかりません' });
  await refreshAccounts();
  await logEvent(rows[0].username, 'account_deleted', req, '管理者による操作');
  return res.json({ ok: true });
});

admin.get('/api/logs', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const username = typeof req.query.username === 'string' ? req.query.username.trim().slice(0, 64) : '';
  const event = typeof req.query.event === 'string' ? req.query.event.trim().slice(0, 40) : '';
  const where = [];
  const params = [];
  if (username) {
    params.push(username);
    where.push('lower(username) = lower($' + params.length + ')');
  }
  if (event) {
    params.push(event);
    where.push('event = $' + params.length);
  }
  params.push(limit, offset);
  const sql = 'SELECT id, at, username, event, detail, ip, ua FROM logs'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY id DESC LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length;
  const { rows } = await q(sql, params);
  res.json(rows);
});

// ---- 管理画面: フィードバックの確認 ----
admin.get('/api/feedback', async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const unreadOnly = req.query.status === 'unread';
  const { rows } = await q(
    `SELECT id, username, category, message, is_read, created_at FROM feedback
     ${unreadOnly ? 'WHERE is_read = FALSE' : ''}
     ORDER BY id DESC LIMIT $1::int OFFSET $2::int`,
    [limit, offset]
  );
  const counts = await q('SELECT count(*) FILTER (WHERE is_read = FALSE)::int AS unread, count(*)::int AS total FROM feedback');
  res.json({ unread: counts.rows[0].unread, total: counts.rows[0].total, items: rows });
});

admin.post('/api/feedback/:id/read', async (req, res) => {
  const id = parseId(req.params.id);
  const read = req.body ? req.body.read : undefined;
  if (!id || typeof read !== 'boolean') return res.status(400).json({ error: 'bad_request', message: '指定が正しくありません' });
  const { rows } = await q('UPDATE feedback SET is_read = $2::boolean WHERE id = $1::int RETURNING id', [id, read]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'フィードバックが見つかりません' });
  return res.json({ ok: true });
});

admin.delete('/api/feedback/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_request', message: '指定が正しくありません' });
  const { rows } = await q('DELETE FROM feedback WHERE id = $1::int RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'フィードバックが見つかりません' });
  return res.json({ ok: true });
});

app.use('/' + ADMIN_PATH, admin);

// ---- 「私の作品」を開くための、短時間だけ有効な取得URL ----
// エディターが project_url で作品を読み込むときに、Cookieが送られなくても取得できるようにする
const DL_TTL_MS = 10 * 60 * 1000;
const makeDlToken = (id) => {
  const exp = Date.now() + DL_TTL_MS;
  return exp + '-' + hmac('dl|' + id + '|' + exp);
};
const verifyDlToken = (id, token) => {
  if (typeof token !== 'string') return false;
  const i = token.indexOf('-');
  if (i < 0) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac('dl|' + id + '|' + exp));
};

app.get('/my/dl/:id/:token/project.sb3', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0 || !verifyDlToken(id, req.params.token)) return res.status(403).end();
  const { rows } = await q(
    'SELECT p.data FROM projects p JOIN accounts a ON a.id = p.account_id WHERE p.id = $1::int AND a.enabled = TRUE',
    [id]
  );
  if (!rows[0]) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.type('application/octet-stream');
  return res.send(rows[0].data);
});

// ---- ここから先は、ログインした利用者だけが見られる ----
app.use((req, res, next) => {
  if (getLoggedInUser(req)) return next();
  res.set('Cache-Control', 'no-store');
  return res.status(401).type('html').send(loginPage());
});

// ---- ログイン中のアカウント名(ナビゲーションバーの表示用) ----
app.get('/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  res.json({ username: acc ? acc.username : '', id: acc ? acc.id : null });
});

// ---- フレンド・共同制作(ログインした利用者だけ) ----
app.get('/collab', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'collab.html'));
});
app.use('/collab/api', createSocialRouter({ express, q, getLoggedInUser, maxProjectBytes: MAX_PROJECT_BYTES }));

// ---- 私の作品(アカウントごとの保存) ----
const requireXhr = (req, res, next) => {
  // 他サイトのフォームなどからの変更操作を拒否する(独自のヘッダーは、他サイトからは付けられない)
  if (req.method !== 'GET' && req.get('X-Mirror') !== '1') {
    return res.status(403).json({ message: '許可されていない操作です' });
  }
  return next();
};
const parseProjectId = (v) => {
  const id = Number.parseInt(v, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const cleanTitle = (t) => (
  typeof t === 'string' ? t.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : ''
);
const isSb3 = (buf) => (
  Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
);
const rawBody = express.raw({ type: () => true, limit: MAX_PROJECT_BYTES });

app.get('/my', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'my.html'));
});


app.get('/my/open/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  const id = parseProjectId(req.params.id);
  if (!id) return res.redirect('/my');
  const { rows } = await q('SELECT id FROM projects WHERE id = $1::int AND account_id = $2::int', [id, acc.id]);
  if (!rows[0]) return res.redirect('/my');
  const fileUrl = req.protocol + '://' + req.get('host') + '/my/dl/' + id + '/' + makeDlToken(id) + '/project.sb3';
  return res.redirect('/editor.html?project_url=' + encodeURIComponent(fileUrl) + '&mirror_pid=' + id + '&mirror_source=myworks');
});

app.get('/my/api/projects', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  const { rows } = await q(
    'SELECT id, title, size, created_at, updated_at FROM projects WHERE account_id = $1::int ORDER BY updated_at DESC',
    [acc.id]
  );
  res.json({ max: MAX_PROJECTS, maxBytes: MAX_PROJECT_BYTES, projects: rows });
});

app.post('/my/api/projects', requireXhr, rawBody, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  if (!isSb3(req.body)) return res.status(400).json({ message: 'sb3ファイルではありません' });
  const title = cleanTitle(req.query.title) || '無題の作品';
  const { rows } = await q(
    `INSERT INTO projects (account_id, title, data, size)
     SELECT $1::int, $2::text, $3::bytea, $4::int
     WHERE (SELECT count(*) FROM projects WHERE account_id = $1::int) < $5::int
     RETURNING id, title`,
    [acc.id, title, req.body, req.body.length, MAX_PROJECTS]
  );
  if (!rows[0]) {
    return res.status(409).json({
      message: '保存できる作品は' + MAX_PROJECTS + '個までです。「私の作品」で、いらない作品を削除してください'
    });
  }
  return res.json({ ok: true, id: rows[0].id, title: rows[0].title });
});

app.put('/my/api/projects/:id', requireXhr, rawBody, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  const id = parseProjectId(req.params.id);
  if (!id) return res.status(400).json({ message: '指定が正しくありません' });
  if (!isSb3(req.body)) return res.status(400).json({ message: 'sb3ファイルではありません' });
  const title = cleanTitle(req.query.title);
  const { rows } = await q(
    `UPDATE projects
     SET data = $3::bytea, size = $4::int, title = COALESCE(NULLIF($5::text, ''), title), updated_at = NOW()
     WHERE id = $1::int AND account_id = $2::int
     RETURNING id, title`,
    [id, acc.id, req.body, req.body.length, title]
  );
  if (!rows[0]) return res.status(404).json({ message: '作品が見つかりません' });
  return res.json({ ok: true, id: rows[0].id, title: rows[0].title });
});

app.post('/my/api/projects/:id/rename', requireXhr, express.json({ limit: '2kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  const id = parseProjectId(req.params.id);
  const title = cleanTitle(req.body ? req.body.title : '');
  if (!id || !title) return res.status(400).json({ message: '名前を入力してください' });
  const { rows } = await q(
    'UPDATE projects SET title = $3::text WHERE id = $1::int AND account_id = $2::int RETURNING id',
    [id, acc.id, title]
  );
  if (!rows[0]) return res.status(404).json({ message: '作品が見つかりません' });
  return res.json({ ok: true });
});

app.delete('/my/api/projects/:id', requireXhr, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  const id = parseProjectId(req.params.id);
  if (!id) return res.status(400).json({ message: '指定が正しくありません' });
  const { rows } = await q('DELETE FROM projects WHERE id = $1::int AND account_id = $2::int RETURNING id', [id, acc.id]);
  if (!rows[0]) return res.status(404).json({ message: '作品が見つかりません' });
  return res.json({ ok: true });
});

app.get('/my/api/projects/:id/file', async (req, res) => {
  const acc = getLoggedInUser(req);
  const id = parseProjectId(req.params.id);
  if (!id) return res.status(400).end();
  const { rows } = await q('SELECT title, data FROM projects WHERE id = $1::int AND account_id = $2::int', [id, acc.id]);
  if (!rows[0]) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(rows[0].title) + '.sb3');
  res.type('application/octet-stream');
  return res.send(rows[0].data);
});

// ---- フィードバック(利用者から管理者へ) ----
const FEEDBACK_CATEGORIES = { bug: '不具合の報告', request: '要望', other: 'その他' };
const FEEDBACK_MAX_CHARS = 2000;
const FEEDBACK_LIMIT_COUNT = 5;      // この回数まで
const FEEDBACK_LIMIT_MINUTES = 10;   // この分数のあいだに送れる

app.get('/feedback', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'feedback.html'));
});

app.post('/feedback/api', requireXhr, express.json({ limit: '16kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = getLoggedInUser(req);
  const body = req.body || {};
  const category = Object.prototype.hasOwnProperty.call(FEEDBACK_CATEGORIES, body.category) ? body.category : 'other';
  const message = typeof body.message === 'string'
    ? body.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
    : '';
  if (!message) return res.status(400).json({ message: '内容を入力してください' });
  if (message.length > FEEDBACK_MAX_CHARS) {
    return res.status(400).json({ message: '内容は' + FEEDBACK_MAX_CHARS + '文字以内にしてください' });
  }
  const recent = await q(
    "SELECT count(*)::int AS n FROM feedback WHERE account_id = $1::int AND created_at > NOW() - ($2::int * INTERVAL '1 minute')",
    [acc.id, FEEDBACK_LIMIT_MINUTES]
  );
  if (recent.rows[0].n >= FEEDBACK_LIMIT_COUNT) {
    return res.status(429).json({ message: '短い時間に送れる回数を超えました。しばらくしてから、もう一度お試しください' });
  }
  await q(
    'INSERT INTO feedback (account_id, username, category, message) VALUES ($1::int, $2::text, $3::text, $4::text)',
    [acc.id, acc.username, category, message]
  );
  return res.json({ ok: true });
});

// ---- 検索機能 ----
const SEARCH_MODES = new Set(['popular', 'trending', 'recent']);
const SEARCH_LIMIT = 20;
const SEARCH_CACHE_MS = 60 * 1000;
const searchCache = new Map();
const SCRATCH_UA = 'turbowarp-mirror-search';

app.get('/search', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'search.html'));
});

app.get('/search-api', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const mode = SEARCH_MODES.has(req.query.mode) ? req.query.mode : 'popular';
  const parsedOffset = Number.parseInt(req.query.offset, 10);
  const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 && parsedOffset <= 2000 ? parsedOffset : 0;

  if (!query) return res.json([]);
  if (query.length > 100) return res.status(400).json({ error: 'query too long' });

  const key = mode + '|' + offset + '|' + query;
  const cached = searchCache.get(key);
  if (cached && cached.expires > Date.now()) return res.json(cached.items);

  try {
    const params = new URLSearchParams({
      q: query,
      mode,
      language: SEARCH_LANGUAGE,
      limit: String(SEARCH_LIMIT),
      offset: String(offset)
    });
    const upstream = await fetch('https://api.scratch.mit.edu/search/projects?' + params.toString(), {
      headers: { 'User-Agent': SCRATCH_UA },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) return res.status(502).json({ error: 'upstream status ' + upstream.status });
    const json = await upstream.json();
    const items = (Array.isArray(json) ? json : []).map((p) => ({
      id: p.id,
      title: String(p.title == null ? '' : p.title),
      author: String(p.author && p.author.username ? p.author.username : ''),
      views: p.stats && p.stats.views ? p.stats.views : 0,
      loves: p.stats && p.stats.loves ? p.stats.loves : 0,
      favorites: p.stats && p.stats.favorites ? p.stats.favorites : 0
    }));
    if (searchCache.size > 200) searchCache.clear();
    searchCache.set(key, { expires: Date.now() + SEARCH_CACHE_MS, items });
    return res.json(items);
  } catch (err) {
    return res.status(502).json({ error: 'search failed' });
  }
});

app.get('/search-thumb/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d{1,12}$/.test(id)) return res.status(400).end();
  try {
    const upstream = await fetch('https://uploads.scratch.mit.edu/projects/thumbnails/' + id + '.png', {
      headers: { 'User-Agent': SCRATCH_UA },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) return res.status(404).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buf);
  } catch (err) {
    return res.status(502).end();
  }
});

// ---- ミラー本体 ----
app.use(express.static(path.join(__dirname, 'scratch-gui/build')));

// ---- エラー処理 ----
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  return res.status(status).json({
    error: 'server_error',
    message: status === 413
      ? 'ファイルが大きすぎます(1つの作品は ' + MAX_PROJECT_MB + 'MB まで)'
      : status === 400
        ? '送信内容が正しくありません'
        : 'サーバーでエラーが発生しました。しばらくしてからやり直してください'
  });
});

// =====================================================================
// 起動
// =====================================================================
const start = async () => {
  await initDb();
  DUMMY_HASH = await hashPassword(crypto.randomBytes(8).toString('hex'));
  await refreshAccounts();
  await cleanupLogs();
  await createSocialRouter.cleanup(q).catch((err) => console.error('共同制作の古いデータの削除に失敗しました:', err.message));

  setInterval(() => {
    refreshAccounts().catch((err) => console.error('アカウント情報の更新に失敗しました:', err.message));
  }, 30 * 1000);
  setInterval(() => {
    cleanupLogs().catch((err) => console.error('古いログの削除に失敗しました:', err.message));
  }, 24 * 60 * 60 * 1000);
  setInterval(() => {
    createSocialRouter.cleanup(q).catch((err) => console.error('共同制作の古いデータの削除に失敗しました:', err.message));
  }, 60 * 60 * 1000);

  const port = process.env.PORT || 10000;
  app.listen(port, () => console.log('Started on port ' + port + ' (admin: /' + ADMIN_PATH + ')'));
};

start().catch((err) => {
  console.error('起動に失敗しました:', err.message);
  process.exit(1);
});
