// ナビゲーションバーの右端に、ログイン中のアカウント名とログアウトのメニューを表示する
(() => {
  if (window.__accountMenuLoaded) return;
  window.__accountMenuLoaded = true;

  const ID = 'mirror-account-menu';
  let username = '';

  const style = document.createElement('style');
  style.textContent = `
    #${ID} { position: relative; display: flex; align-items: center; align-self: stretch;
             flex: 0 0 auto; margin-left: auto; margin-right: 8px; z-index: 1000;
             font-family: system-ui, sans-serif; font-size: 14px; }
    #${ID}.mas-fixed { position: fixed; top: 0; right: 0; height: 48px; margin: 0;
                       z-index: 2147483000; background: rgba(0, 0, 0, .45); }
    #${ID} .mas-name { display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
                       padding: 6px 12px; border: 0; border-radius: 6px; background: transparent;
                       color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    #${ID} .mas-name:hover, #${ID} .mas-name[aria-expanded="true"] { background: rgba(255, 255, 255, .18); }
    #${ID} .mas-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${ID} .mas-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 200px; padding: 10px;
                       border-radius: 8px; background: #fff; color: #111;
                       border: 1px solid rgba(0, 0, 0, .15); box-shadow: 0 6px 20px rgba(0, 0, 0, .3); }
    #${ID} .mas-menu[hidden] { display: none; }
    #${ID} .mas-who { margin-bottom: 8px; font-size: 12px; color: #555; word-break: break-all; }
    #${ID} .mas-logout { display: block; box-sizing: border-box; width: 100%; padding: 8px 12px; border-radius: 6px;
                         background: #FF4C4C; color: #fff; font-weight: 700; text-align: center; text-decoration: none; }
    #${ID} .mas-logout:hover { filter: brightness(0.92); }
  `;
  document.head.append(style);

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
    caret.textContent = '▾';
    btn.append(label, caret);

    const menu = document.createElement('div');
    menu.className = 'mas-menu';
    menu.hidden = true;
    const who = document.createElement('div');
    who.className = 'mas-who';
    who.textContent = 'ログイン中: ' + username;
    const logout = document.createElement('a');
    logout.className = 'mas-logout';
    logout.href = '/logout';
    logout.textContent = 'ログアウト';
    menu.append(who, logout);

    const setOpen = (open) => {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
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
    return wrap;
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
    if (!wrap) wrap = build();
    const bar = findMenuBar();
    wrap.classList.toggle('mas-fixed', !bar);
    const target = bar || document.body;
    if (wrap.parentElement !== target || target.lastElementChild !== wrap) target.append(wrap);
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      attach();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

  fetch('/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data && typeof data.username === 'string' && data.username) {
        username = data.username;
        schedule();
      }
    })
    .catch(() => {});
})();
