const crypto = require('crypto');
const path = require('path');
const express = require('express');

const USER = process.env.BASIC_USER;
const PASS = process.env.BASIC_PASS;
if (!USER || !PASS) {
  console.error('BASIC_USER と BASIC_PASS を設定してください');
  process.exit(1);
}

// 長さが違っても比較できるよう、ハッシュにしてから比較する
const hash = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));

const app = express();
app.set('trust proxy', 1);
app.set('x-powered-by', false);

app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i >= 0) {
      const user = decoded.slice(0, i);
      const pass = decoded.slice(i + 1);
      if (safeEqual(user, USER) && safeEqual(pass, PASS)) return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Mirror", charset="UTF-8"');
  res.status(401).send('Authentication required');
});

app.use(express.static(path.join(__dirname, 'scratch-gui/build')));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('Started on port ' + port));
