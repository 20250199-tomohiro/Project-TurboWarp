/* Shared appearance controls for TurboWarp editor and companion pages. */
(() => {
  const KEY = 'project-turbowarp-appearance-v2';
  const getDefaults = () => {
    let previous = {};
    try { previous = JSON.parse(localStorage.getItem('project-turbowarp-theme') || '{}'); } catch (_) {}
    const mode = previous['color-scheme'] === 'light' || previous['color-scheme'] === 'dark'
      ? previous['color-scheme']
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    return {mode, accentTheme:'red'};
  };
  const read = () => {
    try { return {...getDefaults(), ...(JSON.parse(localStorage.getItem(KEY) || '{}'))}; }
    catch (_) { return getDefaults(); }
  };
  const save = value => {
    const next = {...read(), ...value};
    localStorage.setItem(KEY, JSON.stringify(next));
    apply(next);
    window.dispatchEvent(new CustomEvent('mirror-appearance-change', {detail:next}));
  };
  const colors = mode => mode === 'light' ? {
    page:'#f5f6f8', panel:'#ffffff', panelAlt:'#f0f2f5', text:'#575e75',
    muted:'#858b9e', border:'#d9dde5', soft:'#edf0f5', input:'#ffffff',
    headerAccent:true
  } : {
    page:'#181a1f', panel:'#24272e', panelAlt:'#202329', text:'#f1f1f1',
    muted:'#aab2c0', border:'#3a3f49', soft:'#2c313a', input:'#1e2229',
    headerAccent:false
  };
  const apply = (prefs=read()) => {
    const root=document.documentElement, c=colors(prefs.mode);
    const palettes = {
      red: {accent:'#ff4c4c', hover:'hsla(0, 42%, 51%, 1)'},
      purple: {accent:'hsla(260, 60%, 60%, 1)', hover:'hsla(260, 42%, 51%, 1)'},
      blue: {accent:'hsla(215, 100%, 65%, 1)', hover:'hsla(215, 60%, 50%, 1)'},
      rainbow: {accent:'#ff4c4c', hover:'hsla(0, 42%, 51%, 1)'}
    };
    const selected = palettes[prefs.accentTheme] || palettes.red;
    const accent=selected.accent;
    const hover=selected.hover;
    root.dataset.mirrorTheme=prefs.mode;
    root.dataset.mirrorAccent=accent.slice(1);
    const vars={
      '--mirror-page':c.page,'--mirror-panel':c.panel,'--mirror-panel-alt':c.panelAlt,
      '--mirror-text':c.text,'--mirror-muted':c.muted,'--mirror-border':c.border,
      '--mirror-soft':c.soft,'--mirror-input':c.input,'--mirror-accent':accent,
      '--mirror-accent-hover':hover,'--bg':c.page,'--card':c.panel,'--fg':c.text,
      '--muted':c.muted,'--line':c.border,'--soft':c.soft,'--accent':accent,
      '--page-background':c.page,'--page-foreground':c.text,'--popover-background':c.panel,
      '--input-background':c.input,'--looks-secondary':accent,'--looks-secondary-dark':accent,
      '--motion-primary':accent,'--motion-tertiary':accent,
      '--menu-bar-background':c.headerAccent?accent:'#30343b',
      '--menu-bar-background-image':prefs.accentTheme==='rainbow' ? 'linear-gradient(90deg, rgba(255, 0, 0, 0.75) 0%, rgba(255, 154, 0, 0.75) 10%, rgba(208, 222, 33, 0.75) 20%, rgba(79, 220, 74, 0.75) 30%, rgba(63, 218, 216, 0.75) 40%, rgba(47, 201, 226, 0.75) 50%, rgba(28, 127, 238, 0.75) 60%, rgba(95, 21, 242, 0.75) 70%, rgba(186, 12, 248, 0.75) 80%, rgba(251, 7, 217, 0.75) 90%, rgba(255, 0, 0, 0.75) 100%)' : 'none',
      '--mirror-accent-hover':hover,
      '--menu-bar-foreground':'#ffffff','--ui-modal-header-background':accent
    };
    for(const [k,v] of Object.entries(vars)) root.style.setProperty(k,v);
    root.style.colorScheme=prefs.mode;
  };
  const install = () => {
    apply();
    if(!document.getElementById('mirror-theme-tools')) {
      const details=document.createElement('details'); details.id='mirror-theme-tools';
      const summary=document.createElement('summary'); summary.textContent='⚙ テーマ設定'; details.append(summary);
      const pop=document.createElement('div'); pop.className='mirror-theme-pop';
      const modeLabel=document.createElement('label'); modeLabel.append(document.createTextNode('表示モード'));
      const mode=document.createElement('select');
      [['dark','ダークモード'],['light','ライトモード']].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;mode.append(o)});
      mode.value=read().mode; mode.addEventListener('change',()=>save({mode:mode.value})); modeLabel.append(mode);
      const accentLabel=document.createElement('label'); accentLabel.append(document.createTextNode('アクセントカラー'));
      const accent=document.createElement('select');
      [['red','赤'],['purple','紫'],['blue','青'],['rainbow','レインボー']].forEach(([v,label])=>{const o=document.createElement('option');o.value=v;o.textContent=label;accent.append(o)});
      accent.value=read().accentTheme;
      accent.addEventListener('change',()=>save({accentTheme:accent.value})); accentLabel.append(accent);
      const hint=document.createElement('p'); hint.className='mirror-theme-hint'; hint.textContent='設定はこのブラウザー内で共有されます。';
      pop.append(modeLabel,accentLabel,hint); details.append(pop); document.body.append(details);
      window.addEventListener('mirror-appearance-change',e=>{mode.value=e.detail.mode;accent.value=e.detail.accentTheme;});
      window.addEventListener('storage',e=>{if(e.key===KEY){apply();const p=read();mode.value=p.mode;accent.value=p.accentTheme;}});
    }
  };
  window.MirrorAppearance={get:read,set:save,apply};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install,{once:true}); else install();
})();
