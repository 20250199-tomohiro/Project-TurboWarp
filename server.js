const crypto = require('crypto');
const path = require('path');
const express = require('express');

const PASSWORD = process.env.SITE_PASSWORD;
if (!PASSWORD) {
  console.error('SITE_PASSWORD を設定してください');
  process.exit(1);
}

const COOKIE_NAME = 'mirror_session';
const MAX_AGE_SEC = 7 * 24 * 60 * 60;

// パスワードを変えると、既存のログインは自動的に無効になる
const KEY = crypto.createHash('sha256').update('session-key:' + PASSWORD).digest();
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (v) => crypto.createHmac('sha256', KEY).update(v).digest('hex');

const makeToken = () => {
  const exp = String(Date.now() + MAX_AGE_SEC * 1000);
  return exp + '.' + sign(exp);
};
const verifyToken = (token) => {
  if (!token) return false;
  const i = token.indexOf('.');
  if (i < 0) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
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

// 失敗回数の制限(メモリ上)
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const fails = new Map();
const isBlocked = (ip) => {
  const e = fails.get(ip);
  if (!e) return false;
  if (e.resetAt < Date.now()) {
    fails.delete(ip);
    return false;
  }
  return e.count >= LIMIT;
};
const recordFail = (ip) => {
  const now = Date.now();
  const e = fails.get(ip);
  if (!e || e.resetAt < now) fails.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else e.count++;
};

const loginPage = (message = '') => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>パスワード認証</title>
<style>
  :root { --accent: #FF4C4C; color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
         justify-content: center; gap: 32px; padding: 24px; box-sizing: border-box;
         font-family: system-ui, sans-serif; background: #f3f4f6; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111827; color: #f3f4f6; } }
  .logo { display: block; width: min(720px, 90vw); height: auto; }
  form { width: min(320px, 90vw); padding: 24px; border-radius: 12px; background: rgba(127,127,127,.15); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  input, button { width: 100%; box-sizing: border-box; padding: 10px; font-size: 16px; border-radius: 8px; border: 1px solid #888; }
  input:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
  button { margin-top: 12px; border: 0; background: var(--accent); color: #fff; font-weight: 700; cursor: pointer; }
  button:hover { filter: brightness(0.92); }
  #msg { min-height: 1.5em; margin: 12px 0 0; color: #b00020; font-size: 14px; }
</style>
</head>
<body>
<img class="Turbowarp_logo" src="/Turbowarp_logo.png" alt="TURBOWARP">
<form id="f" method="post" action="/login">
  <h1>パスワードを入力してください</h1>
  <input type="password" name="password" autofocus required autocomplete="current-password" aria-label="パスワード">
  <button type="submit">ログイン</button>
  <p id="msg">${message}</p>
</form>
<script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msg');
    msg.textContent = '';
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams(new FormData(e.target))
      });
      if (res.ok) { location.reload(); return; }
      msg.textContent = res.status === 429
        ? '失敗が続いたため、しばらくしてからやり直してください'
        : 'パスワードが違います';
    } catch (err) {
      msg.textContent = '通信に失敗しました';
    }
  });
</script>
</body>
</html>`;

const app = express();
app.set('trust proxy', 1);
app.set('x-powered-by', false);

app.post('/login', express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
  const ip = req.ip;
  const wantsJson = (req.headers.accept || '').includes('application/json');
  res.set('Cache-Control', 'no-store');

  if (isBlocked(ip)) {
    return wantsJson
      ? res.status(429).json({ ok: false })
      : res.status(429).type('html').send(loginPage('失敗が続いたため、しばらくしてからやり直してください'));
  }

  const input = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (safeEqual(input, PASSWORD)) {
    fails.delete(ip);
    res.cookie(COOKIE_NAME, makeToken(), {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      maxAge: MAX_AGE_SEC * 1000,
      path: '/'
    });
    return wantsJson ? res.json({ ok: true }) : res.redirect('/');
  }

  recordFail(ip);
  return wantsJson
    ? res.status(401).json({ ok: false })
    : res.status(401).type('html').send(loginPage('パスワードが違います'));
});

app.get('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.redirect('/');
});

// ログインしていないアクセスには、同じURLのままログインページを返す
app.get('/logo.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'logo.png'));
});
app.use((req, res, next) => {
  if (verifyToken(getCookie(req, COOKIE_NAME))) return next();
  res.set('Cache-Control', 'no-store');
  res.status(401).type('html').send(loginPage());
});

app.use(express.static(path.join(__dirname, 'scratch-gui/build')));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('Started on port ' + port));
