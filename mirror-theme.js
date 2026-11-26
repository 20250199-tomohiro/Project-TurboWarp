/* Theme bridge for companion pages; reads/writes TurboWarp's native tw:theme preference. */
(() => {
  const KEY='project-turbowarp-appearance-v2';
  const NATIVE_KEY='tw:theme';
  const defaults={mode:'light',accentTheme:'red'};
  const parse=(value,fallback={})=>{try{return {...fallback,...JSON.parse(value||'{}')}}catch(_){return {...fallback}}};
  const nativePrefs=()=>{
    let raw=null; try{raw=localStorage.getItem(NATIVE_KEY)}catch(_){}
    if(raw==='dark'||raw==='light') return {mode:raw,accentTheme:'red'};
    const t=parse(raw,{});
    return {
      mode:t.gui==='dark'?'dark':(t.gui==='light'?'light':defaults.mode),
      accentTheme:['red','purple','blue','rainbow'].includes(t.accent)?t.accent:'red'
    };
  };
  const read=()=>({...nativePrefs(),...parse(localStorage.getItem(KEY),{})});
  const palettes={
    red:{accent:'#ff4c4c',hover:'#cc3333'},
    purple:{accent:'hsla(260, 60%, 60%, 1)',hover:'hsla(260, 42%, 51%, 1)'},
    blue:{accent:'hsla(215, 100%, 65%, 1)',hover:'hsla(215, 60%, 50%, 1)'},
    rainbow:{accent:'#ff4c4c',hover:'#cc3333'}
  };
  const rainbow='linear-gradient(90deg, rgba(255, 0, 0, 0.75) 0%, rgba(255, 154, 0, 0.75) 10%, rgba(208, 222, 33, 0.75) 20%, rgba(79, 220, 74, 0.75) 30%, rgba(63, 218, 216, 0.75) 40%, rgba(47, 201, 226, 0.75) 50%, rgba(28, 127, 238, 0.75) 60%, rgba(95, 21, 242, 0.75) 70%, rgba(186, 12, 248, 0.75) 80%, rgba(251, 7, 217, 0.75) 90%, rgba(255, 0, 0, 0.75) 100%)';
  const apply=(prefs=read())=>{
    const root=document.documentElement,light=prefs.mode==='light',palette=palettes[prefs.accentTheme]||palettes.red;
    const c=light?{page:'#f5f6f8',panel:'#fff',panelAlt:'#f0f2f5',text:'#575e75',muted:'#858b9e',border:'#d9dde5',soft:'#edf0f5',input:'#fff',header:palette.accent}:{page:'#181a1f',panel:'#24272e',panelAlt:'#202329',text:'#f1f1f1',muted:'#aab2c0',border:'#3a3f49',soft:'#2c313a',input:'#1e2229',header:'#30343b'};
    root.dataset.mirrorTheme=prefs.mode;
    const vars={'--mirror-page':c.page,'--mirror-panel':c.panel,'--mirror-panel-alt':c.panelAlt,'--mirror-text':c.text,'--mirror-muted':c.muted,'--mirror-border':c.border,'--mirror-soft':c.soft,'--mirror-input':c.input,'--mirror-accent':palette.accent,'--mirror-accent-hover':palette.hover,'--mirror-header':c.header,'--mirror-header-image':prefs.accentTheme==='rainbow'?(light?rainbow:'none'):'none'};
    for(const [k,v] of Object.entries(vars))root.style.setProperty(k,v);
    root.style.colorScheme=prefs.mode;
  };
  const save=changes=>{
    const next={...read(),...changes};
    localStorage.setItem(KEY,JSON.stringify(next));
    const native=parse(localStorage.getItem(NATIVE_KEY),{});
    native.gui=next.mode; native.accent=next.accentTheme;
    if(next.mode==='light'&&next.accentTheme==='red') localStorage.setItem(NATIVE_KEY,JSON.stringify(native));
    else localStorage.setItem(NATIVE_KEY,JSON.stringify(native));
    apply(next); syncControls(next);
    window.dispatchEvent(new CustomEvent('mirror-appearance-change',{detail:next}));
  };
  const syncControls=p=>{
    const mode=document.querySelector('[data-mirror-mode="'+p.mode+'"]');
    document.querySelectorAll('[data-mirror-mode]').forEach(x=>x.setAttribute('aria-checked',String(x===mode)));
    document.querySelectorAll('[data-mirror-accent]').forEach(x=>x.setAttribute('aria-checked',String(x.dataset.mirrorAccent===p.accentTheme)));
  };
  const install=()=>{
    apply();
    if(document.getElementById('mirror-theme-tools'))return;
    const host=document.querySelector('.mirror-topbar')||document.body;
    const details=document.createElement('details');details.id='mirror-theme-tools';
    const summary=document.createElement('summary');
    const gear=document.createElement('img');gear.className='mirror-settings-icon';gear.src='/mirror-settings-icon.svg';gear.alt='';
    const label=document.createElement('span');label.textContent='設定';
    const caret=document.createElement('span');caret.textContent='▾';caret.className='mirror-settings-caret';
    summary.append(gear,label,caret);details.append(summary);
    const pop=document.createElement('div');pop.className='mirror-theme-pop';
    const modeHeading=document.createElement('div');modeHeading.className='mirror-theme-heading';modeHeading.textContent='表示モード';pop.append(modeHeading);
    [['light','☀','ライトモード'],['dark','☾','ダークモード']].forEach(([value,icon,text])=>{
      const b=document.createElement('button');b.type='button';b.className='mirror-theme-option';b.dataset.mirrorMode=value;b.innerHTML='';
      const glyph=document.createElement('span');glyph.textContent=icon;glyph.style.width='23px';glyph.style.textAlign='center';
      const title=document.createElement('span');title.textContent=text;b.append(glyph,title);
      b.addEventListener('click',()=>save({mode:value}));pop.append(b);
    });
    const divider=document.createElement('div');divider.className='mirror-theme-divider';pop.append(divider);
    const accentHeading=document.createElement('div');accentHeading.className='mirror-theme-heading';accentHeading.textContent='アクセント';pop.append(accentHeading);
    [['red','赤'],['purple','紫'],['blue','青'],['rainbow','レインボー']].forEach(([value,text])=>{
      const b=document.createElement('button');b.type='button';b.className='mirror-theme-option';b.dataset.mirrorAccent=value;
      const swatch=document.createElement('span');swatch.className='mirror-theme-swatch '+value;
      const title=document.createElement('span');title.textContent=text;b.append(swatch,title);
      b.addEventListener('click',()=>save({accentTheme:value}));pop.append(b);
    });
    details.append(pop);host.append(details);syncControls(read());
    window.addEventListener('storage',e=>{if(e.key===KEY||e.key===NATIVE_KEY){apply();syncControls(read());}});
  };
  window.MirrorAppearance={get:read,set:save,apply};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
