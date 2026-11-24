// プロジェクトURL入力欄の横に、検索ページ(/search)へのボタンを追加する
(() => {
  const BUTTON_ID = 'mirror-search-button';

  const findInput = () => {
    for (const el of document.querySelectorAll('input')) {
      const text = (el.placeholder || '') + ' ' + (el.value || '');
      if (text.includes('scratch.mit.edu/projects')) return el;
    }
    return null;
  };

  const apply = () => {
    const input = findInput();
    if (!input || !input.parentElement) return;

    const existing = document.getElementById(BUTTON_ID);
    if (existing && existing.previousElementSibling === input) return;
    if (existing) existing.remove();

    const button = document.createElement('a');
    button.id = BUTTON_ID;
    button.href = '/search';
    button.textContent = '探す';
    button.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'align-self:stretch',
      'flex:0 0 auto',
      'padding:0 20px',
      'border-radius:4px',
      'background:#FF4C4C',
      'color:#fff',
      'font-weight:700',
      'font-size:inherit',
      'text-decoration:none',
      'white-space:nowrap',
      'cursor:pointer'
    ].join(';');
    button.addEventListener('mouseenter', () => { button.style.filter = 'brightness(0.92)'; });
    button.addEventListener('mouseleave', () => { button.style.filter = ''; });

    input.insertAdjacentElement('afterend', button);

    // 入力欄とボタンを横並びにする
    const parent = input.parentElement;
    const display = getComputedStyle(parent).display;
    if (display !== 'flex' && display !== 'inline-flex') {
      parent.style.display = 'flex';
      parent.style.alignItems = 'center';
      parent.style.gap = '8px';
    }
    input.style.flex = '1 1 auto';
    input.style.minWidth = '0';
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
