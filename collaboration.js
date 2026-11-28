const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = (length = 6) => Array.from(crypto.randomBytes(length), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

const MAX_ROOMS_PER_OWNER = 3;
const MAX_MEMBERS_PER_ROOM = 8;
const MAX_TODOS_PER_ROOM = 200;
const REREQUEST_COOLDOWN_HOURS = 24;
const ROOM_IDLE_DAYS = 7;
const LONG_POLL_MS = 25 * 1000;
const LONG_POLL_STEP_MS = 1000;
const MAX_LONG_POLLS_PER_ACCOUNT = 4;

// 回数制限(メモリ上。再起動で消える)。key ごとに windowMs の間に limit 回まで許可する
const makeRate = (limit, windowMs) => {
  const map = new Map();
  return (key) => {
    const now = Date.now();
    if (map.size > 10000) map.clear();
    const e = map.get(key);
    if (!e || e.resetAt < now) {
      map.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (e.count >= limit) return false;
    e.count++;
    return true;
  };
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// SB3(zip)として最低限の形をしているか。先頭の PK\x03\x04 と、project.json の存在を確認する
const looksLikeSb3 = (buf) => (
  Buffer.isBuffer(buf) && buf.length >= 30 &&
  buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 &&
  buf.includes('project.json')
);

const createSchema = async (q) => {
  await q(`CREATE TABLE IF NOT EXISTS friend_codes (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE
  )`);
  await q(`CREATE TABLE IF NOT EXISTS friend_requests (
    id BIGSERIAL PRIMARY KEY,
    from_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(from_id,to_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS friendships (
    account_low INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    account_high INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(account_low,account_high),
    CHECK(account_low < account_high)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS direct_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
  )`);
  await q('CREATE INDEX IF NOT EXISTS direct_messages_pair ON direct_messages(sender_id,recipient_id,id DESC)');
  await q(`CREATE TABLE IF NOT EXISTS collab_rooms (
    id BIGSERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL DEFAULT 0,
    project_data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  await q(`CREATE TABLE IF NOT EXISTS collab_room_members (
    room_id BIGINT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(room_id,account_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS collab_todos (
    id BIGSERIAL PRIMARY KEY,
    room_id BIGINT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
    created_by INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
    done BOOLEAN NOT NULL DEFAULT FALSE,
    position BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS collab_events (
    id BIGSERIAL PRIMARY KEY,
    room_id BIGINT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q('CREATE INDEX IF NOT EXISTS collab_events_room ON collab_events(room_id,id)');
  await q(`CREATE TABLE IF NOT EXISTS collab_presence (
    room_id BIGINT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(room_id,account_id)
  )`);
};

// 古いデータの掃除。起動時と、1日1回程度に呼ぶ
const cleanup = async (q) => {
  await q("DELETE FROM collab_events WHERE created_at < NOW() - INTERVAL '1 day'");
  await q("DELETE FROM collab_presence WHERE updated_at < NOW() - INTERVAL '1 hour'");
  // 一定期間だれも触れていないルームは閉じる(作品データ本体は残る)
  await q(`UPDATE collab_rooms r SET active=FALSE, project_data=NULL
    WHERE r.active=TRUE AND r.updated_at < NOW() - ($1 || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM collab_room_members m WHERE m.room_id=r.id AND m.last_seen > NOW() - ($1 || ' days')::interval)`,
  [String(ROOM_IDLE_DAYS)]);
  // 閉じて7日たったルームは削除する
  await q("DELETE FROM collab_rooms WHERE active=FALSE AND updated_at < NOW() - INTERVAL '7 days'");
};

const createSocialRouter = ({ express, q, getLoggedInUser, maxProjectBytes }) => {
  const router = express.Router();
  const projectLimit = maxProjectBytes || 15 * 1024 * 1024;

  const friendRequestRate = makeRate(20, 60 * 60 * 1000);
  const codeFailRate = makeRate(10, 10 * 60 * 1000); // 存在しないコードを試せる回数
  const joinFailRate = makeRate(10, 10 * 60 * 1000);
  const messageRate = makeRate(30, 60 * 1000);
  const projectPutRate = makeRate(30, 60 * 1000);
  const todoRate = makeRate(60, 60 * 1000);
  const longPolls = new Map();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const account = getLoggedInUser(req);
    if (!account) return res.status(401).json({ message: 'ログインしてください' });
    req.account = account;
    if (req.method !== 'GET') {
      if (req.get('X-Mirror') !== '1') return res.status(403).json({ message: '許可されていない操作です' });
      // 他のサイトからの操作を拒否する(Origin が付いている場合は、このサイトのものだけを許可する)
      const origin = req.get('Origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch (err) { host = ''; }
        if (host !== req.get('Host')) return res.status(403).json({ message: '許可されていない操作です' });
      }
    }
    next();
  });
  const jsonBody = express.json({ limit: '32kb' });

  const pair = (a, b) => [Math.min(a, b), Math.max(a, b)];
  const areFriends = async (a, b) => {
    const [low, high] = pair(a, b);
    const result = await q('SELECT 1 FROM friendships WHERE account_low=$1 AND account_high=$2', [low, high]);
    return result.rowCount > 0;
  };
  const ensureCode = async (accountId) => {
    const existing = await q('SELECT code FROM friend_codes WHERE account_id=$1', [accountId]);
    if (existing.rows[0]) return existing.rows[0].code;
    for (let i = 0; i < 8; i++) {
      const code = makeCode(8);
      try {
        await q('INSERT INTO friend_codes(account_id,code) VALUES($1,$2)', [accountId, code]);
        return code;
      } catch (err) { if (err.code !== '23505') throw err; }
    }
    throw new Error('フレンドコードを発行できませんでした');
  };
  // 作品データ(大きい)は含めずに、メンバーとして参加中のルームを返す。
  // 作成者以外は、いまも作成者とフレンドである場合だけ有効
  const roomForMember = async (code, accountId) => {
    const result = await q(`SELECT r.id,r.code,r.owner_id,r.project_id,r.revision,r.updated_at FROM collab_rooms r
      JOIN collab_room_members m ON m.room_id=r.id
      WHERE r.code=$1 AND r.active=TRUE AND m.account_id=$2::int
      AND (r.owner_id=$2::int OR EXISTS (
        SELECT 1 FROM friendships f
        WHERE f.account_low=LEAST(r.owner_id,$2::int) AND f.account_high=GREATEST(r.owner_id,$2::int)))`,
    [code, accountId]);
    return result.rows[0] || null;
  };
  const codeParam = (req) => String(req.params.code || '').toUpperCase();
  const addEvent = (roomId, accountId, type, payload) => q(
    'INSERT INTO collab_events(room_id,account_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)',
    [roomId, accountId, type, JSON.stringify(payload)]
  );
  const parseId = (v) => {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const guard = (rate, message) => (req, res, next) => (rate(req.account.id)
    ? next()
    : res.status(429).json({ message: message || '操作が多すぎます。しばらくしてからやり直してください' }));

  // ---------------- フレンド ----------------
  router.get('/friends', async (req, res) => {
    const code = await ensureCode(req.account.id);
    const friends = await q(`SELECT a.id,a.username,
        (SELECT COUNT(*)::int FROM direct_messages d WHERE d.sender_id=a.id AND d.recipient_id=$1 AND d.read_at IS NULL) AS unread
      FROM friendships f
      JOIN accounts a ON a.id=CASE WHEN f.account_low=$1 THEN f.account_high ELSE f.account_low END
      WHERE f.account_low=$1 OR f.account_high=$1 ORDER BY a.username`, [req.account.id]);
    const incoming = await q(`SELECT r.id,a.username,r.created_at FROM friend_requests r
      JOIN accounts a ON a.id=r.from_id WHERE r.to_id=$1 AND r.status='pending' ORDER BY r.created_at`, [req.account.id]);
    const outgoing = await q(`SELECT r.id,a.username,r.created_at FROM friend_requests r
      JOIN accounts a ON a.id=r.to_id WHERE r.from_id=$1 AND r.status='pending' ORDER BY r.created_at`, [req.account.id]);
    res.json({ code, friends: friends.rows, incoming: incoming.rows, outgoing: outgoing.rows });
  });

  router.post('/friends/request', jsonBody, guard(friendRequestRate, 'フレンド申請が多すぎます。1時間ほど待ってからやり直してください'), async (req, res) => {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return res.status(400).json({ message: 'フレンドコードを確認してください' });
    const target = await q('SELECT account_id FROM friend_codes WHERE code=$1', [code]);
    if (!target.rows[0] || target.rows[0].account_id === req.account.id) {
      if (!codeFailRate(req.account.id)) return res.status(429).json({ message: '試行が多すぎます。しばらくしてからやり直してください' });
      return res.status(404).json({ message: 'アカウントが見つかりません' });
    }
    const other = target.rows[0].account_id;
    if (await areFriends(req.account.id, other)) return res.status(409).json({ message: 'すでにフレンドです' });
    // 相手からの申請がすでにある場合は、そのまま成立させる
    const reverse = await q(`UPDATE friend_requests SET status='accepted'
      WHERE from_id=$1 AND to_id=$2 AND status='pending' RETURNING id`, [other, req.account.id]);
    if (reverse.rows[0]) {
      const [low, high] = pair(req.account.id, other);
      await q('INSERT INTO friendships(account_low,account_high) VALUES($1,$2) ON CONFLICT DO NOTHING', [low, high]);
      return res.json({ ok: true, accepted: true });
    }
    // 断られた申請は、一定時間は再申請できない
    const existing = await q('SELECT id,status,created_at FROM friend_requests WHERE from_id=$1 AND to_id=$2', [req.account.id, other]);
    const prev = existing.rows[0];
    if (prev && prev.status === 'pending') return res.json({ ok: true, requestId: prev.id });
    if (prev && prev.status === 'rejected' &&
        Date.now() - new Date(prev.created_at).getTime() < REREQUEST_COOLDOWN_HOURS * 3600 * 1000) {
      return res.status(429).json({ message: 'このアカウントには、しばらく申請できません' });
    }
    const result = await q(`INSERT INTO friend_requests(from_id,to_id) VALUES($1,$2)
      ON CONFLICT(from_id,to_id) DO UPDATE SET status='pending',created_at=NOW()
      RETURNING id`, [req.account.id, other]);
    res.json({ ok: true, requestId: result.rows[0].id });
  });

  router.post('/friends/requests/:id/respond', jsonBody, async (req, res) => {
    const id = parseId(req.params.id);
    const accept = !!req.body && req.body.accept === true;
    if (!id) return res.status(400).json({ message: '申請IDが不正です' });
    const result = await q(`UPDATE friend_requests SET status=$3, created_at=CASE WHEN $3='rejected' THEN NOW() ELSE created_at END
      WHERE id=$1 AND to_id=$2 AND status='pending' RETURNING from_id,to_id`,
    [id, req.account.id, accept ? 'accepted' : 'rejected']);
    if (!result.rows[0]) return res.status(404).json({ message: '申請が見つかりません' });
    if (accept) {
      const [low, high] = pair(result.rows[0].from_id, result.rows[0].to_id);
      await q('INSERT INTO friendships(account_low,account_high) VALUES($1,$2) ON CONFLICT DO NOTHING', [low, high]);
    }
    res.json({ ok: true });
  });

  router.delete('/friends/:friendId', async (req, res) => {
    const friendId = parseId(req.params.friendId);
    if (!friendId) return res.status(400).json({ message: 'IDが不正です' });
    const [low, high] = pair(req.account.id, friendId);
    await q('DELETE FROM friendships WHERE account_low=$1 AND account_high=$2', [low, high]);
    // 申請の履歴も消す(解除後にあらためて申請できるように)
    await q('DELETE FROM friend_requests WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)', [req.account.id, friendId]);
    // お互いのルームから、相手を外す(自分が作成したルームから相手を、相手が作成したルームから自分を)
    await q(`DELETE FROM collab_room_members m USING collab_rooms r
      WHERE m.room_id=r.id AND r.owner_id<>m.account_id
      AND ((r.owner_id=$1 AND m.account_id=$2) OR (r.owner_id=$2 AND m.account_id=$1))`, [req.account.id, friendId]);
    res.json({ ok: true });
  });

  // ---------------- メッセージ ----------------
  router.get('/messages/:friendId', async (req, res) => {
    const friendId = parseId(req.params.friendId);
    if (!friendId || !(await areFriends(req.account.id, friendId))) return res.status(403).json({ message: 'フレンドではありません' });
    const result = await q(`SELECT id,sender_id,recipient_id,body,created_at,read_at FROM (
      SELECT * FROM direct_messages WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)
      ORDER BY id DESC LIMIT 100) m ORDER BY id ASC`, [req.account.id, friendId]);
    await q('UPDATE direct_messages SET read_at=NOW() WHERE sender_id=$1 AND recipient_id=$2 AND read_at IS NULL', [friendId, req.account.id]);
    res.json({ messages: result.rows });
  });

  router.post('/messages/:friendId', jsonBody, guard(messageRate), async (req, res) => {
    const friendId = parseId(req.params.friendId);
    const body = req.body && typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!friendId || !(await areFriends(req.account.id, friendId))) return res.status(403).json({ message: 'フレンドではありません' });
    if (!body || body.length > 2000) return res.status(400).json({ message: 'メッセージは1〜2000文字にしてください' });
    const result = await q('INSERT INTO direct_messages(sender_id,recipient_id,body) VALUES($1,$2,$3) RETURNING id,created_at', [req.account.id, friendId, body]);
    res.json({ ok: true, ...result.rows[0] });
  });

  // ---------------- ルーム ----------------
  router.get('/rooms', async (req, res) => {
    const result = await q(`SELECT r.code,r.owner_id,a.username AS owner_name,r.project_id,r.revision,r.updated_at
      FROM collab_rooms r JOIN collab_room_members m ON m.room_id=r.id
      JOIN accounts a ON a.id=r.owner_id
      WHERE r.active=TRUE AND m.account_id=$1::int
      AND (r.owner_id=$1::int OR EXISTS (
        SELECT 1 FROM friendships f
        WHERE f.account_low=LEAST(r.owner_id,$1::int) AND f.account_high=GREATEST(r.owner_id,$1::int)))
      ORDER BY r.updated_at DESC`, [req.account.id]);
    res.json({ rooms: result.rows.map(r => ({ ...r, revision: Number(r.revision), isOwner: r.owner_id === req.account.id })) });
  });

  router.post('/rooms', jsonBody, async (req, res) => {
    const projectId = parseId(req.body && req.body.projectId);
    if (!projectId) return res.status(400).json({ message: '作品を指定してください' });
    const project = await q('SELECT id FROM projects WHERE id=$1 AND account_id=$2', [projectId, req.account.id]);
    if (!project.rows[0]) return res.status(404).json({ message: '自分の作品が見つかりません。「私の作品」に保存してから作成してください' });
    const count = await q('SELECT COUNT(*)::int AS n FROM collab_rooms WHERE owner_id=$1 AND active=TRUE', [req.account.id]);
    if (count.rows[0].n >= MAX_ROOMS_PER_OWNER) {
      return res.status(409).json({ message: '同時に作れるルームは' + MAX_ROOMS_PER_OWNER + 'つまでです。使っていないルームを閉じてください' });
    }
    for (let i = 0; i < 12; i++) {
      const code = makeCode(6);
      try {
        const created = await q(`INSERT INTO collab_rooms(code,owner_id,project_id,project_data)
          SELECT $1,$2,id,data FROM projects WHERE id=$3 AND account_id=$2
          RETURNING id,code,revision`, [code, req.account.id, projectId]);
        await q('INSERT INTO collab_room_members(room_id,account_id) VALUES($1,$2)', [created.rows[0].id, req.account.id]);
        return res.json({ code: created.rows[0].code, revision: Number(created.rows[0].revision) });
      } catch (err) { if (err.code !== '23505') throw err; }
    }
    return res.status(503).json({ message: '参加コードを発行できませんでした' });
  });

  router.post('/rooms/join', jsonBody, async (req, res) => {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return res.status(400).json({ message: '6桁の参加コードを入力してください' });
    const found = await q('SELECT id,owner_id FROM collab_rooms WHERE code=$1 AND active=TRUE', [code]);
    if (!found.rows[0]) {
      if (!joinFailRate(req.account.id)) return res.status(429).json({ message: '試行が多すぎます。しばらくしてからやり直してください' });
      return res.status(404).json({ message: 'ルームが見つかりません' });
    }
    const room = found.rows[0];
    if (room.owner_id !== req.account.id && !(await areFriends(room.owner_id, req.account.id))) {
      // コードの存在を推測されないよう、見つからない場合と同じ扱いにする
      if (!joinFailRate(req.account.id)) return res.status(429).json({ message: '試行が多すぎます。しばらくしてからやり直してください' });
      return res.status(404).json({ message: 'ルームが見つかりません。ルームの作成者とフレンドになってから参加してください' });
    }
    const members = await q('SELECT COUNT(*)::int AS n, BOOL_OR(account_id=$2) AS already FROM collab_room_members WHERE room_id=$1', [room.id, req.account.id]);
    if (!members.rows[0].already && members.rows[0].n >= MAX_MEMBERS_PER_ROOM) {
      return res.status(409).json({ message: 'このルームは満員です(' + MAX_MEMBERS_PER_ROOM + '人まで)' });
    }
    await q('INSERT INTO collab_room_members(room_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [room.id, req.account.id]);
    await addEvent(room.id, req.account.id, 'member-joined', { accountId: req.account.id });
    res.json({ ok: true, code });
  });

  router.get('/rooms/:code', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: '参加中のルームが見つかりません' });
    await q('UPDATE collab_room_members SET last_seen=NOW() WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    const members = await q(`SELECT a.id,a.username,m.joined_at,m.last_seen,
        (m.last_seen > NOW()-INTERVAL '90 seconds') AS online
      FROM collab_room_members m JOIN accounts a ON a.id=m.account_id
      WHERE m.room_id=$1 ORDER BY m.joined_at`, [room.id]);
    const todos = await q('SELECT id,title,done,created_by,position FROM collab_todos WHERE room_id=$1 ORDER BY position,id', [room.id]);
    const last = await q('SELECT COALESCE(MAX(id),0) AS id FROM collab_events WHERE room_id=$1', [room.id]);
    res.json({
      code: room.code,
      projectId: room.project_id,
      ownerId: room.owner_id,
      isOwner: room.owner_id === req.account.id,
      revision: Number(room.revision),
      lastEventId: Number(last.rows[0].id),
      maxMembers: MAX_MEMBERS_PER_ROOM,
      members: members.rows,
      todos: todos.rows
    });
  });

  // ルームから抜ける(作成者は抜けられない。ルームを閉じる)
  router.post('/rooms/:code/leave', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (room.owner_id === req.account.id) return res.status(400).json({ message: '作成者はルームを閉じてください' });
    await q('DELETE FROM collab_room_members WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    await q('DELETE FROM collab_presence WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    await addEvent(room.id, req.account.id, 'member-left', { accountId: req.account.id });
    res.json({ ok: true });
  });

  // 作成者が、参加者をルームから外す
  router.delete('/rooms/:code/members/:accountId', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    const target = parseId(req.params.accountId);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (room.owner_id !== req.account.id) return res.status(403).json({ message: '参加者を外せるのは作成者だけです' });
    if (!target || target === req.account.id) return res.status(400).json({ message: '外す参加者を指定してください' });
    await q('DELETE FROM collab_room_members WHERE room_id=$1 AND account_id=$2', [room.id, target]);
    await q('DELETE FROM collab_presence WHERE room_id=$1 AND account_id=$2', [room.id, target]);
    await addEvent(room.id, req.account.id, 'member-removed', { accountId: target });
    res.json({ ok: true });
  });

  // ---------------- ToDo ----------------
  router.post('/rooms/:code/todos', jsonBody, guard(todoRate), async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    const title = req.body && typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!title || title.length > 300) return res.status(400).json({ message: 'ToDoは1〜300文字にしてください' });
    const count = await q('SELECT COUNT(*)::int AS n FROM collab_todos WHERE room_id=$1', [room.id]);
    if (count.rows[0].n >= MAX_TODOS_PER_ROOM) return res.status(409).json({ message: 'ToDoが多すぎます。完了したものを削除してください' });
    const result = await q('INSERT INTO collab_todos(room_id,created_by,title,position) VALUES($1,$2,$3,(SELECT COALESCE(MAX(position),0)+1 FROM collab_todos WHERE room_id=$1)) RETURNING id,title,done,created_by,position', [room.id, req.account.id, title]);
    await addEvent(room.id, req.account.id, 'todo-added', result.rows[0]);
    res.json(result.rows[0]);
  });

  // 完了の切り替えは、参加者なら誰でもできる
  router.patch('/rooms/:code/todos/:todoId', jsonBody, guard(todoRate), async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    const id = parseId(req.params.todoId);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!id) return res.status(400).json({ message: 'ToDo IDが不正です' });
    const result = await q('UPDATE collab_todos SET done=$3 WHERE id=$1 AND room_id=$2 RETURNING id,title,done,created_by,position', [id, room.id, !!req.body && req.body.done === true]);
    if (!result.rows[0]) return res.status(404).json({ message: 'ToDoが見つかりません' });
    await addEvent(room.id, req.account.id, 'todo-updated', result.rows[0]);
    res.json(result.rows[0]);
  });

  // 削除できるのは、そのToDoを作った人と、ルームの作成者だけ
  router.delete('/rooms/:code/todos/:todoId', guard(todoRate), async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    const id = parseId(req.params.todoId);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!id) return res.status(400).json({ message: 'ToDo IDが不正です' });
    const result = await q(`DELETE FROM collab_todos WHERE id=$1 AND room_id=$2 AND (created_by=$3 OR $4::boolean) RETURNING id`,
      [id, room.id, req.account.id, room.owner_id === req.account.id]);
    if (!result.rows[0]) return res.status(403).json({ message: 'このToDoを削除できるのは、作成した人とルームの作成者だけです' });
    await addEvent(room.id, req.account.id, 'todo-deleted', { id });
    res.json({ ok: true });
  });

  router.post('/rooms/:code/heartbeat', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    await q('UPDATE collab_room_members SET last_seen=NOW() WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    res.json({ ok: true });
  });

  // ルームを閉じる。このとき、共有中の最新の作品を、作成者の元の作品へ書き戻す
  router.delete('/rooms/:code', async (req, res) => {
    const code = codeParam(req);
    const room = await q('SELECT id,project_id,project_data FROM collab_rooms WHERE code=$1 AND owner_id=$2 AND active=TRUE', [code, req.account.id]);
    if (!room.rows[0]) return res.status(404).json({ message: '自分が作成したルームが見つかりません' });
    const data = room.rows[0].project_data;
    if (data && looksLikeSb3(Buffer.from(data))) {
      await q('UPDATE projects SET data=$2,size=$3,updated_at=NOW() WHERE id=$1', [room.rows[0].project_id, data, data.length]);
    }
    await q('UPDATE collab_rooms SET active=FALSE,project_data=NULL,updated_at=NOW() WHERE id=$1', [room.rows[0].id]);
    await q('DELETE FROM collab_presence WHERE room_id=$1', [room.rows[0].id]);
    res.json({ ok: true });
  });

  // ---------------- 共有している作品 ----------------
  // 共有中の作品は、ルームの中だけで更新される。作成者の元の作品は、ルームを閉じるときに更新される
  router.get('/rooms/:code/project', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const row = await q('SELECT project_data FROM collab_rooms WHERE id=$1', [room.id]);
    const data = row.rows[0] && row.rows[0].project_data;
    if (!data) return res.status(404).json({ message: '共有作品データがありません' });
    res.json({ revision: Number(room.revision), data: Buffer.from(data).toString('base64') });
  });

  router.get('/rooms/:code/project.sb3', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const row = await q('SELECT project_data FROM collab_rooms WHERE id=$1', [room.id]);
    const data = row.rows[0] && row.rows[0].project_data;
    if (!data) return res.status(404).json({ message: '共有作品データがありません' });
    res.set('X-Collab-Revision', String(Number(room.revision)));
    res.set('Content-Disposition', 'attachment; filename="project.sb3"');
    res.type('application/octet-stream');
    res.send(data);
  });

  router.put('/rooms/:code/project', guard(projectPutRate), express.raw({ type: () => true, limit: projectLimit }), async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!looksLikeSb3(req.body) || req.body.length > projectLimit) {
      return res.status(400).json({ message: '有効なSB3プロジェクトデータではありません' });
    }
    const header = req.get('X-Collab-Revision');
    const expected = Number(header);
    if (header === undefined || !Number.isSafeInteger(expected) || expected < 0) return res.status(400).json({ message: 'リビジョン番号が不正です' });
    const saved = await q(`UPDATE collab_rooms SET project_data=$3,revision=revision+1,updated_at=NOW()
      WHERE id=$1 AND revision=$2 AND active=TRUE RETURNING revision`, [room.id, expected, req.body]);
    if (!saved.rows[0]) {
      const latest = await q('SELECT revision FROM collab_rooms WHERE id=$1', [room.id]);
      return res.status(409).json({ message: '他の参加者が先に変更しました。最新の作品を取得してから、もう一度保存してください', revision: Number(latest.rows[0].revision) });
    }
    const revision = Number(saved.rows[0].revision);
    await addEvent(room.id, req.account.id, 'project-updated', { revision });
    res.json({ ok: true, revision });
  });

  // ---------------- 更新の通知 ----------------
  // 新しいイベントが来るまで最大25秒待つ(ロングポーリング)
  router.get('/rooms/:code/events', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const after = Math.max(0, Number(req.query.after) || 0);
    const active = longPolls.get(req.account.id) || 0;
    if (active >= MAX_LONG_POLLS_PER_ACCOUNT) return res.status(429).json({ message: '同時に待機できる数を超えました' });
    longPolls.set(req.account.id, active + 1);
    let closed = false;
    res.on('close', () => { closed = true; });
    try {
      const deadline = Date.now() + (req.query.wait === '0' ? 0 : LONG_POLL_MS);
      for (;;) {
        const events = await q(`SELECT id,account_id,event_type,payload,created_at FROM collab_events
          WHERE room_id=$1 AND id>$2 AND account_id<>$3 ORDER BY id ASC LIMIT 100`, [room.id, after, req.account.id]);
        if (events.rows.length || closed || Date.now() >= deadline) {
          if (!closed) res.json({ events: events.rows });
          return;
        }
        await sleep(LONG_POLL_STEP_MS);
      }
    } finally {
      const n = (longPolls.get(req.account.id) || 1) - 1;
      if (n <= 0) longPolls.delete(req.account.id); else longPolls.set(req.account.id, n);
    }
  });

  // ---------------- 編集中の場所の共有 ----------------
  router.put('/rooms/:code/presence', jsonBody, async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const state = req.body && typeof req.body === 'object' ? req.body : {};
    const safe = {
      sprite: typeof state.sprite === 'string' ? state.sprite.slice(0, 100) : null,
      target: typeof state.target === 'string' ? state.target.slice(0, 100) : null,
      x: Number.isFinite(state.x) ? Math.max(-100000, Math.min(100000, state.x)) : null,
      y: Number.isFinite(state.y) ? Math.max(-100000, Math.min(100000, state.y)) : null,
      editing: typeof state.editing === 'string' ? state.editing.slice(0, 120) : null
    };
    await q(`INSERT INTO collab_presence(room_id,account_id,state,updated_at) VALUES($1,$2,$3::jsonb,NOW())
      ON CONFLICT(room_id,account_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`,
    [room.id, req.account.id, JSON.stringify(safe)]);
    await q('UPDATE collab_room_members SET last_seen=NOW() WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    res.json({ ok: true });
  });

  router.get('/rooms/:code/presence', async (req, res) => {
    const room = await roomForMember(codeParam(req), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const result = await q(`SELECT a.id,a.username,p.state,p.updated_at FROM collab_presence p
      JOIN accounts a ON a.id=p.account_id WHERE p.room_id=$1 AND p.updated_at>NOW()-INTERVAL '30 seconds'`, [room.id]);
    res.json({ participants: result.rows });
  });

  return router;
};

module.exports = createSocialRouter;
module.exports.createSchema = createSchema;
module.exports.cleanup = cleanup;
