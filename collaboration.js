const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = (length = 6) => Array.from(crypto.randomBytes(length), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

const createSocialRouter = ({ express, q, getLoggedInUser, maxProjectBytes }) => {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const account = getLoggedInUser(req);
    if (!account) return res.status(401).json({ message: 'ログインしてください' });
    req.account = account;
    if (req.method !== 'GET' && req.get('X-Mirror') !== '1') {
      return res.status(403).json({ message: '許可されていない操作です' });
    }
    next();
  });

  let schemaPromise;
  const ensureSchema = () => {
    if (!schemaPromise) schemaPromise = (async () => {
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
    })().catch(err => { schemaPromise = null; throw err; });
    return schemaPromise;
  };

  const ready = (handler) => async (req, res, next) => {
    try { await ensureSchema(); await handler(req, res, next); } catch (err) { next(err); }
  };
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
  const roomForMember = async (code, accountId) => {
    const result = await q(`SELECT r.* FROM collab_rooms r
      JOIN collab_room_members m ON m.room_id=r.id
      WHERE r.code=$1 AND r.active=TRUE AND m.account_id=$2`, [code, accountId]);
    return result.rows[0] || null;
  };

  router.get('/friends', ready(async (req, res) => {
    const code = await ensureCode(req.account.id);
    const friends = await q(`SELECT a.id,a.username FROM friendships f
      JOIN accounts a ON a.id=CASE WHEN f.account_low=$1 THEN f.account_high ELSE f.account_low END
      WHERE f.account_low=$1 OR f.account_high=$1 ORDER BY a.username`, [req.account.id]);
    const incoming = await q(`SELECT r.id,a.username,r.created_at FROM friend_requests r
      JOIN accounts a ON a.id=r.from_id WHERE r.to_id=$1 AND r.status='pending' ORDER BY r.created_at`, [req.account.id]);
    const outgoing = await q(`SELECT r.id,a.username,r.created_at FROM friend_requests r
      JOIN accounts a ON a.id=r.to_id WHERE r.from_id=$1 AND r.status='pending' ORDER BY r.created_at`, [req.account.id]);
    res.json({ accountId: req.account.id, code, friends: friends.rows, incoming: incoming.rows, outgoing: outgoing.rows });
  }));

  router.post('/friends/request', ready(async (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return res.status(400).json({ message: 'フレンドコードを確認してください' });
    const target = await q('SELECT account_id FROM friend_codes WHERE code=$1', [code]);
    if (!target.rows[0] || target.rows[0].account_id === req.account.id) return res.status(404).json({ message: 'アカウントが見つかりません' });
    const other = target.rows[0].account_id;
    if (await areFriends(req.account.id, other)) return res.status(409).json({ message: 'すでにフレンドです' });
    try {
      const result = await q(`INSERT INTO friend_requests(from_id,to_id) VALUES($1,$2)
        ON CONFLICT(from_id,to_id) DO UPDATE SET status='pending',created_at=NOW()
        RETURNING id`, [req.account.id, other]);
      res.json({ ok: true, requestId: result.rows[0].id });
    } catch (err) { throw err; }
  }));

  router.post('/friends/requests/:id/respond', ready(async (req, res) => {
    const id = Number(req.params.id);
    const accept = req.body.accept === true;
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: '申請IDが不正です' });
    const result = await q(`UPDATE friend_requests SET status=$3
      WHERE id=$1 AND to_id=$2 AND status='pending' RETURNING from_id,to_id`,
    [id, req.account.id, accept ? 'accepted' : 'rejected']);
    if (!result.rows[0]) return res.status(404).json({ message: '申請が見つかりません' });
    if (accept) {
      const [low, high] = pair(result.rows[0].from_id, result.rows[0].to_id);
      await q('INSERT INTO friendships(account_low,account_high) VALUES($1,$2) ON CONFLICT DO NOTHING', [low, high]);
    }
    res.json({ ok: true });
  }));

  router.delete('/friends/:friendId', ready(async (req, res) => {
    const friendId = Number(req.params.friendId);
    if (!Number.isSafeInteger(friendId) || friendId < 1) return res.status(400).json({ message: 'IDが不正です' });
    const [low, high] = pair(req.account.id, friendId);
    await q('DELETE FROM friendships WHERE account_low=$1 AND account_high=$2', [low, high]);
    res.json({ ok: true });
  }));

  router.get('/messages/:friendId', ready(async (req, res) => {
    const friendId = Number(req.params.friendId);
    if (!Number.isSafeInteger(friendId) || !(await areFriends(req.account.id, friendId))) return res.status(403).json({ message: 'フレンドではありません' });
    const result = await q(`SELECT id,sender_id,recipient_id,body,created_at,read_at FROM (
      SELECT * FROM direct_messages WHERE (sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)
      ORDER BY id DESC LIMIT 100) m ORDER BY id ASC`, [req.account.id, friendId]);
    await q('UPDATE direct_messages SET read_at=NOW() WHERE sender_id=$1 AND recipient_id=$2 AND read_at IS NULL', [friendId, req.account.id]);
    res.json({ messages: result.rows });
  }));

  router.post('/messages/:friendId', ready(async (req, res) => {
    const friendId = Number(req.params.friendId);
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!Number.isSafeInteger(friendId) || !(await areFriends(req.account.id, friendId))) return res.status(403).json({ message: 'フレンドではありません' });
    if (!body || body.length > 2000) return res.status(400).json({ message: 'メッセージは1〜2000文字にしてください' });
    const result = await q('INSERT INTO direct_messages(sender_id,recipient_id,body) VALUES($1,$2,$3) RETURNING id,created_at', [req.account.id, friendId, body]);
    res.json({ ok: true, ...result.rows[0] });
  }));

  router.post('/rooms', ready(async (req, res) => {
    const projectId = Number(req.body.projectId);
    if (!Number.isSafeInteger(projectId) || projectId < 1) return res.status(400).json({ message: '作品を指定してください' });
    const project = await q('SELECT id FROM projects WHERE id=$1 AND account_id=$2', [projectId, req.account.id]);
    if (!project.rows[0]) return res.status(404).json({ message: '自分の作品が見つかりません。「私の作品」に保存してから作成してください' });
    for (let i = 0; i < 12; i++) {
      const code = makeCode(6);
      try {
        const created = await q(`INSERT INTO collab_rooms(code,owner_id,project_id,project_data)
          SELECT $1,$2,id,data FROM projects WHERE id=$3 AND account_id=$2
          RETURNING id,code,revision`, [code, req.account.id, projectId]);
        await q('INSERT INTO collab_room_members(room_id,account_id) VALUES($1,$2)', [created.rows[0].id, req.account.id]);
        return res.json(created.rows[0]);
      } catch (err) { if (err.code !== '23505') throw err; }
    }
    return res.status(503).json({ message: '参加コードを発行できませんでした' });
  }));

  router.post('/rooms/join', ready(async (req, res) => {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return res.status(400).json({ message: '6桁の参加コードを入力してください' });
    const found = await q('SELECT id,owner_id FROM collab_rooms WHERE code=$1 AND active=TRUE', [code]);
    if (!found.rows[0]) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (found.rows[0].owner_id !== req.account.id && !(await areFriends(found.rows[0].owner_id, req.account.id))) {
      return res.status(403).json({ message: 'ルームの作成者とフレンドになってから参加してください' });
    }
    await q('INSERT INTO collab_room_members(room_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [found.rows[0].id, req.account.id]);
    res.json({ ok: true, code });
  }));

  router.get('/rooms/:code', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: '参加中のルームが見つかりません' });
    await q('UPDATE collab_room_members SET last_seen=NOW() WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    const members = await q(`SELECT a.id,a.username,m.joined_at,m.last_seen
      FROM collab_room_members m JOIN accounts a ON a.id=m.account_id
      WHERE m.room_id=$1 AND m.last_seen > NOW()-INTERVAL '90 seconds' ORDER BY m.joined_at`, [room.id]);
    const todos = await q('SELECT id,title,done,created_by,position FROM collab_todos WHERE room_id=$1 ORDER BY position,id', [room.id]);
    res.json({ code: room.code, projectId: room.project_id, revision: Number(room.revision), members: members.rows, todos: todos.rows });
  }));

  router.post('/rooms/:code/todos', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!title || title.length > 300) return res.status(400).json({ message: 'ToDoは1〜300文字にしてください' });
    const result = await q('INSERT INTO collab_todos(room_id,created_by,title,position) VALUES($1,$2,$3,(SELECT COALESCE(MAX(position),0)+1 FROM collab_todos WHERE room_id=$1)) RETURNING id,title,done,created_by,position', [room.id, req.account.id, title]);
    await q('INSERT INTO collab_events(room_id,account_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)', [room.id, req.account.id, 'todo-added', JSON.stringify(result.rows[0])]);
    res.json(result.rows[0]);
  }));

  router.patch('/rooms/:code/todos/:todoId', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    const id = Number(req.params.todoId);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ message: 'ToDo IDが不正です' });
    const result = await q('UPDATE collab_todos SET done=$3 WHERE id=$1 AND room_id=$2 RETURNING id,title,done,created_by,position', [id, room.id, req.body.done === true]);
    if (!result.rows[0]) return res.status(404).json({ message: 'ToDoが見つかりません' });
    await q('INSERT INTO collab_events(room_id,account_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)', [room.id, req.account.id, 'todo-updated', JSON.stringify(result.rows[0])]);
    res.json(result.rows[0]);
  }));

  router.delete('/rooms/:code/todos/:todoId', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    const id = Number(req.params.todoId);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    await q('DELETE FROM collab_todos WHERE id=$1 AND room_id=$2', [id, room.id]);
    await q('INSERT INTO collab_events(room_id,account_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)', [room.id, req.account.id, 'todo-deleted', JSON.stringify({ id })]);
    res.json({ ok: true });
  }));

  router.post('/rooms/:code/heartbeat', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    await q('UPDATE collab_room_members SET last_seen=NOW() WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    res.json({ ok: true });
  }));

  router.delete('/rooms/:code/leave', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: '参加中のルームが見つかりません' });
    await q('DELETE FROM collab_room_members WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    await q('DELETE FROM collab_presence WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    res.json({ ok: true });
  }));

  router.delete('/rooms/:code', ready(async (req, res) => {
    const result = await q('UPDATE collab_rooms SET active=FALSE WHERE code=$1 AND owner_id=$2 RETURNING id', [req.params.code.toUpperCase(), req.account.id]);
    if (!result.rows[0]) return res.status(404).json({ message: '自分が作成したルームが見つかりません' });
    res.json({ ok: true });
  }));


  // Shared project snapshot: every room member edits one canonical SB3 document.
  router.get('/rooms/:code/project', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const data = room.project_data;
    if (!data) return res.status(404).json({ message: '共有作品データがありません' });
    res.json({ revision: Number(room.revision), data: Buffer.from(data).toString('base64') });
  }));

  router.put('/rooms/:code/project', express.raw({ type: 'application/octet-stream', limit: maxProjectBytes || '50mb' }), ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 4 || req.body.length > maxProjectBytes || req.body[0] !== 0x50 || req.body[1] !== 0x4b) {
      return res.status(400).json({ message: '有効なSB3プロジェクトデータではありません' });
    }
    const expected = Number(req.get('X-Collab-Revision'));
    if (!Number.isSafeInteger(expected) || expected < 0) return res.status(400).json({ message: 'リビジョン番号が不正です' });
    const saved = await q(`UPDATE collab_rooms SET project_data=$3,revision=revision+1,updated_at=NOW()
      WHERE id=$1 AND revision=$2 RETURNING revision,project_id`, [room.id, expected, req.body]);
    if (!saved.rows[0]) {
      const latest = await q('SELECT revision FROM collab_rooms WHERE id=$1', [room.id]);
      return res.status(409).json({ message: '他の参加者が先に変更しました。最新の作品を再読み込みしてください', revision: Number(latest.rows[0].revision) });
    }
    await q('UPDATE projects SET data=$2,size=$3,updated_at=NOW() WHERE id=$1', [saved.rows[0].project_id, req.body, req.body.length]);
    await q('INSERT INTO collab_events(room_id,account_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)',
      [room.id, req.account.id, 'project-updated', JSON.stringify({ revision: Number(saved.rows[0].revision) })]);
    res.json({ ok: true, revision: Number(saved.rows[0].revision) });
  }));

  // Lightweight long-poll endpoint used by clients to receive room updates.
  router.get('/rooms/:code/events', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const after = Math.max(0, Number(req.query.after) || 0);
    const events = await q(`SELECT id,account_id,event_type,payload,created_at FROM collab_events
      WHERE room_id=$1 AND id>$2 AND account_id<>$3 ORDER BY id ASC LIMIT 100`, [room.id, after, req.account.id]);
    res.json({ events: events.rows });
  }));

  // Participants publish editor selection/cursor metadata. This does not expose private keystrokes.
  router.put('/rooms/:code/presence', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const state = req.body && typeof req.body === 'object' ? req.body : {};
    const safe = {
      sprite: typeof state.sprite === 'string' ? state.sprite.slice(0, 100) : null,
      target: typeof state.target === 'string' ? state.target.slice(0, 100) : null,
      blockId: typeof state.blockId === 'string' ? state.blockId.slice(0, 100) : null,
      blockType: typeof state.blockType === 'string' ? state.blockType.slice(0, 100) : null,
      x: Number.isFinite(state.x) ? Math.max(-100000, Math.min(100000, state.x)) : null,
      y: Number.isFinite(state.y) ? Math.max(-100000, Math.min(100000, state.y)) : null,
      editing: typeof state.editing === 'string' ? state.editing.slice(0, 120) : null
    };
    await q(`INSERT INTO collab_presence(room_id,account_id,state,updated_at) VALUES($1,$2,$3::jsonb,NOW())
      ON CONFLICT(room_id,account_id) DO UPDATE SET state=EXCLUDED.state,updated_at=NOW()`,
      [room.id, req.account.id, JSON.stringify(safe)]);
    await q('UPDATE collab_room_members SET last_seen=NOW() WHERE room_id=$1 AND account_id=$2', [room.id, req.account.id]);
    res.json({ ok: true });
  }));

  router.get('/rooms/:code/presence', ready(async (req, res) => {
    const room = await roomForMember(req.params.code.toUpperCase(), req.account.id);
    if (!room) return res.status(404).json({ message: 'ルームが見つかりません' });
    const result = await q(`SELECT a.id,a.username,p.state,p.updated_at FROM collab_presence p
      JOIN accounts a ON a.id=p.account_id WHERE p.room_id=$1 AND p.updated_at>NOW()-INTERVAL '30 seconds'`, [room.id]);
    res.json({ participants: result.rows });
  }));

  return router;
};

module.exports = createSocialRouter;
