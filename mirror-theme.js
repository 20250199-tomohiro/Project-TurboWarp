/* Shared TurboWarp-style navigation, theme controls and account dropdown. */
(() => {
  const KEY='project-turbowarp-appearance-v2';
  const parse=(s,f={})=>{try{return {...f,...JSON.parse(s||'{}')}}catch(_){return {...f}}};
  const palettes={red:['#ff4c4c','#e04444'],purple:['#9966ff','#8555e6'],blue:['#4c97ff','#3685ee'],rainbow:['#ff4c4c','#e04444']};
  const read=()=>parse(localStorage.getItem(KEY),{mode:'dark',accentTheme:'red'});
  const apply=()=>{
    const p=read(),light=p.mode==='light',colors=palettes[p.accentTheme]||palettes.red;
    const root=document.documentElement;
    const vars=light?{'--mirror-page':'#f5f6f8','--mirror-panel':'#fff','--mirror-panel-alt':'#f0f2f5','--mirror-text':'#575e75','--mirror-muted':'#858b9e','--mirror-border':'#d9dde5','--mirror-soft':'#edf0f5','--mirror-input':'#fff','--mirror-header':colors[0]}:{'--mirror-page':'#181a1f','--mirror-panel':'#24272e','--mirror-panel-alt':'#202329','--mirror-text':'#f1f1f1','--mirror-muted':'#aab2c0','--mirror-border':'#3a3f49','--mirror-soft':'#2c313a','--mirror-input':'#1e2229','--mirror-header':'#30343b'};
    root.dataset.mirrorTheme=p.mode;
    Object.entries({...vars,'--mirror-accent':colors[0],'--mirror-accent-hover':colors[1]}).forEach(([k,v])=>root.style.setProperty(k,v));
    root.style.colorScheme=p.mode;
  };
  const save=change=>{const p={...read(),...change};localStorage.setItem(KEY,JSON.stringify(p));apply();sync();};
  const el=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=txt;return n;};
  const button=(text,action,cls='mirror-menu-option')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
  const menu=(id,label,iconText)=>{
    const d=el('details','mirror-menu-dropdown');d.id=id;
    const summary=el('summary','mirror-menu-trigger');
    if(iconText==='gear'){
      const img=el('img','mirror-settings-icon');img.src='/mirror-settings-icon.svg';img.alt='';
      img.style.cssText='display:block!important;width:20px!important;height:20px!important;max-width:20px!important;max-height:20px!important;object-fit:contain!important;flex:0 0 20px!important';
      summary.append(img);
    }
    summary.append(el('span','',label),el('span','mirror-caret','▾'));
    const pop=el('div','mirror-menu-pop');d.append(summary,pop);return {d,pop};
  };
  const sync=()=>{
    const p=read();
    document.querySelectorAll('[data-theme-mode]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.themeMode===p.mode)));
    document.querySelectorAll('[data-theme-accent]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.themeAccent===p.accentTheme)));
  };
  const install=async()=>{
    apply();
    const header=document.querySelector('header.mirror-topbar');if(!header||header.dataset.enhanced==='1')return;
    header.dataset.enhanced='1';
    const nav=header.querySelector('.mirror-main-nav');
    if(nav){
      nav.querySelectorAll('a').forEach(a=>{if(a.getAttribute('href')===location.pathname)a.setAttribute('aria-current','page');});
    }
    const tools=el('div','mirror-header-tools');
    const settings=menu('mirror-theme-tools','設定','gear');
    settings.pop.append(el('div','mirror-menu-section-title','表示モード'));
    [['light','ライトモード','☀'],['dark','ダークモード','☾']].forEach(([v,t,ico])=>{
      const b=button(ico+'　'+t,()=>save({mode:v}));b.dataset.themeMode=v;settings.pop.append(b);
    });
    const sep=el('div','mirror-menu-separator');settings.pop.append(sep,el('div','mirror-menu-section-title','アクセント'));
    [['red','赤','#ff4c4c'],['purple','紫','#9966ff'],['blue','青','#4c97ff'],['rainbow','レインボー','linear-gradient(90deg,red,orange,yellow,green,blue,violet)']].forEach(([v,t,c])=>{
      const b=button('',()=>save({accentTheme:v}));b.dataset.themeAccent=v;
      const sw=el('span','mirror-accent-swatch');sw.style.background=c;b.append(sw,document.createTextNode(t));settings.pop.append(b);
    });
    const account=menu('mirror-account-menu','アカウント','');
    const accountStatus=el('div','mirror-account-status','読み込み中…');account.pop.append(accountStatus);
    const loadAccount=async()=>{
      try{
        const r=await fetch('/api/account/me',{credentials:'same-origin',cache:'no-store'});
        if(!r.ok)throw Error('ログインしていません');
        const a=await r.json();accountStatus.replaceChildren(el('strong','mirror-account-name',a.username),el('small','mirror-account-id','ID: '+a.id));
        account.pop.append(el('div','mirror-menu-separator'));
        account.pop.append(button('フレンド',()=>location.href='/friends'),button('メッセージ',()=>location.href='/messages'),button('私の作品',()=>location.href='/my'),button('ログアウト',()=>location.href='/logout'));
        try{
          const f=await fetch('/api/social/friends',{credentials:'same-origin',cache:'no-store'});
          if(f.ok){const d=await f.json();account.pop.insertBefore(button('フレンドコード：'+d.code,()=>{navigator.clipboard?.writeText(d.code)}),account.pop.children[1]);}
        }catch(_){}
      }catch(_){accountStatus.textContent='ログイン';account.pop.append(button('ログイン',()=>location.href='/login'));}
    };
    tools.append(settings.d,account.d);
    const search=header.querySelector('.mirror-search-form');if(search)header.insertBefore(tools,search);else header.append(tools);
    await loadAccount();sync();
    document.addEventListener('click',e=>{document.querySelectorAll('.mirror-menu-dropdown[open]').forEach(d=>{if(!d.contains(e.target))d.open=false;});});
    window.addEventListener('storage',e=>{if(e.key===KEY){apply();sync();}});
  };
  window.MirrorAppearance={get:read,set:save,apply};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
