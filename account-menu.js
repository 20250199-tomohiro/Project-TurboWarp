// ナビゲーションバーの右端に、ログイン中のアカウント名とメニュー(私の作品・保存・ログアウト)を表示する
(() => {
  if (window.__accountMenuLoaded) return;
  window.__accountMenuLoaded = true;

  const ID = 'mirror-account-menu';
  let username = '';
  let projects = [];
  let maxProjects = 5;
  let maxBytes = 15 * 1024 * 1024;
  let currentPid = null;
  let vmCache = null;

// 「私の作品」から開いたかどうか
const openedFromMyWorks =
  new URLSearchParams(location.search).get('mirror_source') === 'myworks';

try {
  const pid = new URLSearchParams(location.search).get('mirror_pid');
  if (/^\d+$/.test(pid || '')) currentPid = Number(pid);
} catch (e) { /* 何もしない */ }
  const style = document.createElement('style');
  style.textContent = `
    #${ID} { position:absolute; top:0; right:8px; display:flex; align-items:center;
      height:48px; z-index:1000; margin:0; font:13px "Helvetica Neue",Helvetica,Arial,sans-serif; }
    #${ID}.mas-fixed { position:fixed; top:0; right:0; height:48px; z-index:2147483000; background:transparent; }
    #${ID} .mas-name { display:inline-flex; align-items:center; gap:8px; max-width:220px;
      height:40px; padding:0 14px; border:0; border-radius:7px;
      background:var(--mirror-soft, #edf0f5); color:var(--mirror-text, #575e75);
      font:700 14px "Helvetica Neue",Helvetica,Arial,sans-serif; cursor:pointer; }
    #${ID} .mas-name:hover, #${ID} .mas-name[aria-expanded="true"] { background:var(--mirror-border, #d9dde5); }
    #${ID} .mas-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${ID} .mas-caret, .mirror-caret { display:inline-block; width:0; height:0;
      border-left:4px solid transparent; border-right:4px solid transparent;
      border-top:5px solid currentColor; font-size:0; line-height:0; opacity:.9; }
    #${ID} .mas-menu { position:absolute; top:calc(100% + 6px); right:0; min-width:344px; padding:8px;
      border-radius:8px; background:var(--mirror-panel, #fff); color:var(--mirror-text, #575e75);
      display:flex; flex-direction:column; gap:8px; border:1px solid var(--mirror-border, #d9dde5);
      box-shadow:0 8px 24px rgba(0,0,0,.18); }
    #${ID} .mas-menu[hidden] { display:none; }
    #${ID} .mas-who { padding:8px 10px 4px; margin:0; font-size:14px; font-weight:700;
      color:var(--mirror-text, #575e75); word-break:break-all; }
    #${ID} .mas-item, #${ID} .mas-logout { display:block; box-sizing:border-box; width:100%;
      min-height:42px; padding:9px 12px; border-radius:7px; border:0;
      font:700 14px "Helvetica Neue",Helvetica,Arial,sans-serif; text-align:center;
      text-decoration:none; cursor:pointer; }
    #${ID} .mas-item { background:var(--mirror-soft, #edf0f5); color:var(--mirror-text, #575e75); }
    #${ID} .mas-item:hover { background:var(--mirror-border, #d9dde5); }
    #${ID} .mas-item[hidden] { display:none!important; }
    #${ID} .mas-item:disabled { opacity:.6; cursor:default; }
    #${ID} .mas-logout { background:var(--mirror-accent, #ff4c4c); color:#fff; }
    #${ID} .mas-logout:hover { filter:brightness(.92); }
    #${ID} .mas-sep { height:1px; margin:1px 0; background:var(--mirror-border, #d9dde5); }
    #mirror-toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:2147483001;
      max-width:min(90vw,480px); padding:10px 16px; border-radius:8px;
      background:var(--mirror-accent,#ff4c4c); color:#fff; font:14px system-ui,sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,.4); }
    #mirror-toast.error { background:var(--error-primary,#d94b4b); }
  `;
  document.head.append(style);

  // ---------- 通知 ----------
  let toastTimer = null;
  const toast = (text, isError = false) => {
    let el = document.getElementById('mirror-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mirror-toast';
      el.setAttribute('role', 'status');
      document.body.append(el);
    }
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
  };

  // ---------- 作品の一覧 ----------
  const api = async (path, opts = {}) => {
    const headers = { 'X-Mirror': '1' };
    if (opts.raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
    else if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      credentials: 'same-origin',
      body: opts.raw !== undefined ? opts.raw : (opts.json !== undefined ? JSON.stringify(opts.json) : undefined)
    });
    if (res.status === 401) {
      location.reload();
      throw new Error('ログインが必要です');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || ('エラーが発生しました(' + res.status + ')'));
    return data;
  };

  const refreshProjects = async () => {
    try {
      const data = await api('/my/api/projects');
      projects = data.projects || [];
      maxProjects = data.max || maxProjects;
      maxBytes = data.maxBytes || maxBytes;
    } catch (err) { /* 一覧が取れなくても、メニューは使える */ }
  };

  // ---------- エディターの作品データ(VM)を探す ----------
  // TurboWarp の画面部品(React)をたどって、作品を書き出せる vm を見つける
  const findVm = () => {
    const isVm = (v) => v && typeof v.saveProjectSb3 === 'function' && typeof v.loadProject === 'function';
    const fiberOf = (el) => {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactContainer$')) return el[k];
      }
      const r = el._reactRootContainer;
      if (r) return (r._internalRoot && r._internalRoot.current) || r.current || null;
      return null;
    };
    const seen = new Set();
    let tried = 0;
    for (const el of [document.body, ...document.querySelectorAll('div')]) {
      if (tried >= 40) break;
      const fiber = fiberOf(el);
      if (!fiber) continue;
      let root = fiber;
      while (root.return) root = root.return;
      if (seen.has(root)) continue;
      seen.add(root);
      tried++;
      const visited = new Set();
      const stack = [root];
      let steps = 0;
      while (stack.length && steps++ < 400000) {
        const f = stack.pop();
        if (!f || visited.has(f)) continue;
        visited.add(f);
        const p = f.memoizedProps;
        if (p && typeof p === 'object' && isVm(p.vm)) return p.vm;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    }
    return null;
  };
  const getVm = () => {
    if (!vmCache) vmCache = findVm();
    return vmCache;
  };

  // ---------- 保存 ----------
  let saving = false;
  const saveProject = async (overwrite) => {
    if (saving) return;
    const vm = getVm();
    if (!vm) {
      toast('このページでは保存できません。エディターを開いてから、もう一度お試しください', true);
      return;
    }
    saving = true;
    try {
      toast('保存中…');
      let blob;
      try {
        blob = await vm.saveProjectSb3();
      } catch (err) {
        toast('作品の書き出しに失敗しました', true);
        return;
      }
      if (!blob || !blob.size) {
        toast('作品の書き出しに失敗しました', true);
        return;
      }
      if (blob.size > maxBytes) {
        toast('作品が大きすぎます(上限 ' + Math.round(maxBytes / 1024 / 1024) + 'MB)', true);
        return;
      }

      let result;
      if (overwrite && currentPid) {
        result = await api('/my/api/projects/' + currentPid, { method: 'PUT', raw: blob });
      } else {
        const name = prompt('作品の名前を入力してください', '無題の作品');
        if (name === null) {
          toast('保存をやめました');
          return;
        }
        result = await api('/my/api/projects?title=' + encodeURIComponent(name.trim() || '無題の作品'), { method: 'POST', raw: blob });
        currentPid = result.id;
        try {
          const url = new URL(location.href);
          url.searchParams.set('mirror_pid', String(result.id));
          history.replaceState(history.state, '', url.toString());
        } catch (e) { /* 何もしない */ }
      }
      toast('「' + result.title + '」を保存しました');
      await refreshProjects();
      updateMenu();
    } catch (err) {
      toast(err.message || '保存に失敗しました', true);
    } finally {
      saving = false;
    }
  };

  const socialApi = async (path, options = {}) => {
    const response = await fetch('/api/social' + path, {
      method: options.method || 'GET', credentials: 'same-origin',
      headers: { 'X-Mirror': '1', ...(options.json !== undefined ? {'Content-Type':'application/json'} : {}) },
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || '通信に失敗しました');
    return data;
  };
  const showFriendCode = async () => { try { const d = await socialApi('/friends'); alert('フレンドコード: ' + d.code); } catch (e) { toast(e.message, true); } };
  const addFriend = async () => {
    const code = prompt('相手のフレンドコードを入力してください'); if (!code) return;
    try { await socialApi('/friends/request', {method:'POST', json:{code}}); toast('フレンド申請を送信しました'); } catch (e) { toast(e.message, true); }
  };
  const showFriends = async () => {
    try { const d = await socialApi('/friends');
      const list = (d.friends || []).map(x => x.id + ': ' + x.username).join('\n') || 'まだフレンドはいません';
      const incoming = (d.incoming || []).map(x => x.id + ': ' + x.username).join('\n') || '申請はありません';
      alert('フレンド一覧\n' + list + '\n\n受信した申請\n' + incoming);
      if (d.incoming && d.incoming.length) { const v = prompt('承認する申請IDを入力（拒否は先頭に -）'); if (v) { const n = Number(v); if (Number.isInteger(n) && n) await socialApi('/friends/requests/' + Math.abs(n) + '/respond', {method:'POST',json:{accept:n>0}}); } }
    } catch (e) { toast(e.message, true); }
  };
  const openMessages = async () => {
    try { const d = await socialApi('/friends'); if (!d.friends.length) return toast('先にフレンドを追加してください', true);
      const id = Number(prompt('相手のIDを入力\n' + d.friends.map(x => x.id + ': ' + x.username).join('\n')));
      if (!d.friends.some(x => x.id === id)) return;
      const h = await socialApi('/messages/' + id); alert((h.messages || []).map(m => (m.sender_id === id ? '相手: ' : '自分: ') + m.body).join('\n') || 'メッセージはありません');
      const body = prompt('送信するメッセージ'); if (body && body.trim()) { await socialApi('/messages/' + id, {method:'POST',json:{body}}); toast('送信しました'); }
    } catch (e) { toast(e.message, true); }
  };
  const openCollabRoom = code => { const url = new URL(window.location.href); url.searchParams.set('collab_room', code); window.location.assign(url.toString()); };
  const createRoom = async () => {
    const projectId = currentPid || Number(prompt('共同制作する「私の作品」のID')); if (!Number.isInteger(projectId) || projectId < 1) return;
    try { const r = await socialApi('/rooms', {method:'POST',json:{projectId}}); openCollabRoom(r.code); } catch (e) { toast(e.message, true); }
  };
  const manageRoom = async () => {
    const code = prompt('管理する共同制作ルームの6桁コード'); if (!code) return;
    try {
      const state = await socialApi('/rooms/' + encodeURIComponent(code));
      const members = (state.members || []).map(x => x.username).join(', ') || 'なし';
      const todos = state.todos || [];
      const summary = todos.map(x => (x.done ? '[完了] ' : '[ ] ') + x.id + ': ' + x.title).join('\n') || 'ToDoはありません';
      const action = prompt('参加者: ' + members + '\n\nToDo:\n' + summary + '\n\n操作: a=追加 / c=完了切替 / d=削除 / x=閉じる');
      if (action === 'a') { const title = prompt('ToDoの内容'); if (title) await socialApi('/rooms/' + encodeURIComponent(code) + '/todos', {method:'POST',json:{title}}); }
      if (action === 'c' || action === 'd') { const id = Number(prompt('対象ToDoのID')); if (Number.isInteger(id) && id > 0) {
        const todo = todos.find(x => x.id === id); if (!todo) return;
        if (action === 'c') await socialApi('/rooms/' + encodeURIComponent(code) + '/todos/' + id, {method:'PATCH',json:{done:!todo.done}});
        else await socialApi('/rooms/' + encodeURIComponent(code) + '/todos/' + id, {method:'DELETE'});
      } }
      if (action === 'a' || action === 'c' || action === 'd') toast('ToDoを更新しました');
    } catch (e) { toast(e.message, true); }
  };
  const joinRoom = async () => {
    const code = prompt('6桁の共同制作コード'); if (!code) return;
    try { const r = await socialApi('/rooms/join', {method:'POST',json:{code}}); openCollabRoom(r.code); } catch (e) { toast(e.message, true); }
  };
  // ---------- メニュー ----------
  const els = {};
  const build = () => {
    const wrap = document.createElement('div');
    wrap.id = ID;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mas-name';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'mas-label';
    label.textContent = username;
    const caret = document.createElement('span');
    caret.setAttribute('aria-hidden', 'true');
    caret.className = 'mas-caret';
    btn.append(label, caret);

    const menu = document.createElement('div');
    menu.className = 'mas-menu';
    menu.hidden = true;

    const who = document.createElement('div');
    who.className = 'mas-who';
    who.textContent = 'ログイン中: ' + username;

    const myLink = document.createElement('a');
    myLink.className = 'mas-item';
    myLink.href = '/my';

    const saveNew = document.createElement('button');
    saveNew.type = 'button';
    saveNew.className = 'mas-item';
    saveNew.addEventListener('click', () => { setOpen(false); saveProject(false); });

    const saveOver = document.createElement('button');
    saveOver.type = 'button';
    saveOver.className = 'mas-item';
    saveOver.addEventListener('click', () => { setOpen(false); saveProject(true); });

    const profileLink = document.createElement('a');
    profileLink.className = 'mas-item';
    profileLink.href = '/account';
    profileLink.textContent = 'アカウントページ';

    const sep = document.createElement('div');
    sep.className = 'mas-sep';

    const logout = document.createElement('a');
    logout.className = 'mas-logout';
    logout.href = '/logout';
    logout.textContent = 'ログアウト';

    // 機能ページへの導線は共通ナビゲーションバーに集約し、
    // アカウントメニューには重複して表示しない。
    menu.append(who, profileLink, myLink, saveNew, saveOver, sep, logout);

    const setOpen = (open) => {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) refreshProjects().then(updateMenu);
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });

    wrap.append(btn, menu);
    Object.assign(els, { myLink, saveNew, saveOver });
    return wrap;
  };

  const updateMenu = () => {
    if (!els.myLink) return;
    els.myLink.textContent = '私の作品(' + projects.length + ' / ' + maxProjects + ')';
    const full = projects.length >= maxProjects;
    els.saveNew.textContent = '新しい作品として保存';
    els.saveNew.disabled = full;
    els.saveNew.title = full ? '保存できる作品は' + maxProjects + '個までです。「私の作品」で削除してください' : '';
    const target = currentPid ? projects.find((p) => p.id === currentPid) : null;
    els.saveOver.hidden = !target;
    if (target) els.saveOver.textContent = '上書き保存「' + target.title + '」';
  };

  // TurboWarp のメニューバー(「設定」「ファイル」などが並ぶ横長の領域)を探す。見つからなければ画面右上に固定する
  const findMenuBar = () => {
    for (const el of document.querySelectorAll('[class*="menu-bar_menu-bar_"]')) {
      const rect = el.getBoundingClientRect();
      const display = getComputedStyle(el).display;
      if ((display === 'flex' || display === 'inline-flex') && rect.top < 100 && rect.width > 300) return el;
    }
    return null;
  };

  const attach = () => {
    if (!username) return;
    let wrap = document.getElementById(ID);
    if (!wrap) {
      wrap = build();
      updateMenu();
    }
    const bar = findMenuBar();
    wrap.classList.toggle('mas-fixed', !bar);
    const target = bar || document.body;
    if (bar) {
      if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
      bar.style.paddingRight = '190px';
    }
    if (wrap.parentElement !== target || target.lastElementChild !== wrap) target.append(wrap);
  };

  // ---------- TurboWarp 標準の「パソコンへの保存」を使えなくする ----------
  // 「コンピューターに保存」と「"ファイル名".sb3 に保存」の2つのメニュー項目を隠し、Ctrl+S も止める
  const HIDE_PATTERNS = [
    /コンピュー?ターに保存/,
    /Save to your computer/i,
    /\.sb3.*保存|保存.*\.sb3/,
    /Save as .*\.sb3/i
  ];
  const shouldHide = (text) => HIDE_PATTERNS.some((re) => re.test(text));
  const hideSaveItems = () => {
    // ファイルメニューの項目と、バーの右側に出る「コンピューターに保存する」ボタンの両方を対象にする
    for (const el of document.querySelectorAll('[class*="menu_menu-item"], [role="menuitem"], li, [class*="save-status_save-now"]')) {
      if (el.dataset.masHidden || el.closest('#' + ID)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 80) continue;
      if (shouldHide(text)) {
        el.style.display = 'none';
        el.dataset.masHidden = '1';
      }
    }
  };
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast('パソコンへの保存はできません。アカウント名のメニューから、「私の作品」に保存してください');
    }
  }, true);

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      attach();
      hideSaveItems();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();

  fetch('/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data && typeof data.username === 'string' && data.username) {
        username = data.username;
        schedule();
        refreshProjects().then(updateMenu);
      }
    })
    .catch(() => {});
})();
