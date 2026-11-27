/* Shared TurboWarp-style navigation, theme controls and account dropdown. */
(() => {
  const KEY='project-turbowarp-appearance-v2';
  const parse=(s,f={})=>{try{return {...f,...JSON.parse(s||'{}')}}catch(_){return {...f}}};
  const palettes={red:['#ff4c4c','#e04444'],purple:['#9966ff','#8555e6'],blue:['#4c97ff','#3685ee'],rainbow:['#ff4c4c','#e04444']};
  const read=()=>{
    const native=parse(localStorage.getItem('tw:theme'),{});
    const saved=parse(localStorage.getItem(KEY),{});
    return {mode:saved.mode||native.gui||'light',accentTheme:saved.accentTheme||native.accent||'red'};
  };
  const apply=()=>{
    const p=read(),light=p.mode==='light',colors=palettes[p.accentTheme]||palettes.red;
    const root=document.documentElement;
    const vars=light?{'--mirror-page':'#f5f6f8','--mirror-panel':'#fff','--mirror-panel-alt':'#f0f2f5','--mirror-text':'#575e75','--mirror-muted':'#858b9e','--mirror-border':'#d9dde5','--mirror-soft':'#edf0f5','--mirror-input':'#fff','--mirror-header':colors[0]}:{'--mirror-page':'#181a1f','--mirror-panel':'#24272e','--mirror-panel-alt':'#202329','--mirror-text':'#f1f1f1','--mirror-muted':'#aab2c0','--mirror-border':'#3a3f49','--mirror-soft':'#2c313a','--mirror-input':'#1e2229','--mirror-header':'#30343b'};
    root.dataset.mirrorTheme=p.mode;
    Object.entries({...vars,'--mirror-accent':colors[0],'--mirror-accent-hover':colors[1]}).forEach(([k,v])=>root.style.setProperty(k,v));
    root.style.colorScheme=p.mode;
  };
  const save=change=>{
    const p={...read(),...change};
    localStorage.setItem(KEY,JSON.stringify(p));
    const native=parse(localStorage.getItem('tw:theme'),{});
    native.gui=p.mode;
    native.accent=p.accentTheme;
    localStorage.setItem('tw:theme',JSON.stringify(native));
    apply();sync();
  };
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
    summary.append(el('span','',label),el('span','mirror-caret',''));
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
    tools.append(settings.d);
    const search=header.querySelector('.mirror-search-form');if(search)header.insertBefore(tools,search);else header.append(tools);
    sync();
    document.addEventListener('click',e=>{document.querySelectorAll('.mirror-menu-dropdown[open]').forEach(d=>{if(!d.contains(e.target))d.open=false;});});
    window.addEventListener('storage',e=>{if(e.key===KEY){apply();sync();}});
  };
  // Companion-page translations follow the locale selected in TurboWarp.
  const translations={
    en:{
      'ホーム':'Home','私の作品':'My Stuff','作品を探す':'Explore','フレンド':'Friends','メッセージ':'Messages','共同制作':'Collaboration','パッケージ化':'Packager','設定':'Settings','アカウント':'Account','ライトモード':'Light Mode','ダークモード':'Dark Mode','アクセント':'Accent','赤':'Red','紫':'Purple','青':'Blue','レインボー':'Rainbow',
      'TurboWarpへようこそ！':'Welcome to TurboWarp!','作品を作ったり、保存した作品を開いたり、ほかのユーザーの作品を探したりできます。':'Create projects, open your saved projects, and discover projects by other users.','新しいプロジェクトを作る':'Create a new project','エディターを開いて、新しい作品を作成します。':'Open the editor and create a new project.','保存したプロジェクトを確認・編集します。':'View and edit your saved projects.','公開されているScratch作品を検索します。':'Search public Scratch projects.','フレンドコードや申請を管理します。':'Manage friend codes and requests.','フレンドとのメッセージを確認します。':'View messages from friends.','ルームを作成して一緒に作品を編集します。':'Create a room and edit projects together.','作品をHTMLなどの形式に書き出します。':'Export projects as HTML and other formats.',
      'あなたのフレンドコード':'Your friend code','このコードを相手に伝えてください。':'Share this code with someone.','コピー':'Copy','フレンドを追加':'Add a friend','相手から教えてもらった8桁のコードを入力。':'Enter the 8-character code you received.','申請する':'Send request','フレンド一覧':'Friends list','届いているフレンド申請':'Incoming friend requests','送信した申請':'Sent requests','フレンドコードを交換して、作品づくりを一緒に楽しもう。':'Exchange friend codes and enjoy creating projects together.',
      'ログアウト':'Log out','読み込み中…':'Loading…','ログイン':'Log in','検索':'Search','検索する':'Search','プロジェクトを探す':'Explore projects','共同制作ルーム':'Collaboration room','パッケージ化':'Package project'
    },
    es:{'ホーム':'Inicio','私の作品':'Mis proyectos','作品を探す':'Explorar','フレンド':'Amigos','メッセージ':'Mensajes','共同制作':'Colaboración','パッケージ化':'Empaquetador','設定':'Ajustes','アカウント':'Cuenta','ライトモード':'Modo claro','ダークモード':'Modo oscuro','TurboWarpへようこそ！':'¡Te damos la bienvenida a TurboWarp!','新しいプロジェクトを作る':'Crear un proyecto nuevo','フレンド一覧':'Lista de amigos','フレンドを追加':'Añadir amigo','コピー':'Copiar','ログアウト':'Cerrar sesión'},
    fr:{'ホーム':'Accueil','私の作品':'Mes projets','作品を探す':'Explorer','フレンド':'Amis','メッセージ':'Messages','共同制作':'Collaboration','パッケージ化':'Emballer','設定':'Paramètres','アカウント':'Compte','ライトモード':'Mode clair','ダークモード':'Mode sombre','TurboWarpへようこそ！':'Bienvenue sur TurboWarp !','新しいプロジェクトを作る':'Créer un projet','フレンド一覧':'Liste d’amis','フレンドを追加':'Ajouter un ami','コピー':'Copier','ログアウト':'Se déconnecter'},
    de:{'ホーム':'Startseite','私の作品':'Meine Projekte','作品を探す':'Entdecken','フレンド':'Freunde','メッセージ':'Nachrichten','共同制作':'Zusammenarbeit','パッケージ化':'Paketieren','設定':'Einstellungen','アカウント':'Konto','ライトモード':'Hellmodus','ダークモード':'Dunkelmodus','TurboWarpへようこそ！':'Willkommen bei TurboWarp!','新しいプロジェクトを作る':'Neues Projekt erstellen','フレンド一覧':'Freundesliste','フレンドを追加':'Freund hinzufügen','コピー':'Kopieren','ログアウト':'Abmelden'},
    'zh-CN':{'ホーム':'首页','私の作品':'我的作品','作品を探す':'探索作品','フレンド':'好友','メッセージ':'消息','共同制作':'协作','パッケージ化':'打包','設定':'设置','アカウント':'账户','ライトモード':'浅色模式','ダークモード':'深色模式','TurboWarpへようこそ！':'欢迎使用 TurboWarp！','新しいプロジェクトを作る':'创建新项目','フレンド一覧':'好友列表','フレンドを追加':'添加好友','コピー':'复制','ログアウト':'退出登录'}
  };
  const getLocale=()=>{
    const candidates=['scratch-language','locale','language','tw:locale'];
    for(const key of candidates){const value=localStorage.getItem(key);if(value){try{const parsed=JSON.parse(value);const candidate=typeof parsed==='string'?parsed:(parsed.locale||parsed.language||parsed.lang);if(candidate)return String(candidate);}catch(_){return value.replace(/^['"]|['"]$/g,'');}}}
    for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key||!/language|locale/i.test(key))continue;const value=localStorage.getItem(key)||'';if(/^[a-z]{2}([_-][A-Za-z]{2,4})?$/i.test(value))return value;}
    return document.documentElement.lang||navigator.language||'en';
  };
  const translate=()=>{
    const raw=getLocale().replace('_','-').toLowerCase();
    const locale=raw.startsWith('zh')?'zh-CN':raw.split('-')[0];
    const dict=translations[locale];if(!dict)return;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
    nodes.forEach(node=>{const original=node.nodeValue;const trimmed=original.trim();if(dict[trimmed])node.nodeValue=original.replace(trimmed,dict[trimmed]);});
    document.querySelectorAll('input[placeholder],textarea[placeholder],button[title],[aria-label]').forEach(node=>{
      ['placeholder','title','aria-label'].forEach(attr=>{const value=node.getAttribute(attr);if(value&&dict[value])node.setAttribute(attr,dict[value]);});
    });
    document.documentElement.lang=locale;
  };
  let translating=false;
  const scheduleTranslate=()=>{if(translating)return;translating=true;requestAnimationFrame(()=>{translating=false;translate();});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scheduleTranslate,{once:true});else scheduleTranslate();
  new MutationObserver(scheduleTranslate).observe(document.body,{childList:true,subtree:true,characterData:true});
  window.addEventListener('storage',e=>{if(/language|locale/i.test(e.key||''))scheduleTranslate();});
  window.MirrorAppearance={get:read,set:save,apply};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();
})();
