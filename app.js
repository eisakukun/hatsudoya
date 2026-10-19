// 初ドヤ（友だち向けPWA版）。mvp/app.js の画面をそのまま使い、保存先をこのMacのAPIから Supabase に替えたもの。
// 表と権限は supabase/schema.sql。画面からは rpc（決まった窓口）と photos バケットだけを触る。
(() => {
'use strict';
const $=id=>document.getElementById(id), esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const categories={daily:'🌿 暮らし',food:'☕ 食・料理',challenge:'🚀 挑戦',outing:'🧭 おでかけ',hobby:'🎨 好きなこと'};
const reactions={doya:'👏 初ドヤ！',step:'🌱 いい一歩',relate:'☺ わかる'};
const reasons={harassment:'嫌がらせ・いじめ',danger:'危険・脅迫',sexual:'性的な内容',privacy:'個人情報・権利侵害',spam:'迷惑投稿',other:'その他'};
const avatars=['🌱','☕','🐈','🌼','🦉','🍊'];
const CFG=window.HATSU_CONFIG||{};
const configured=/^(https:\/\/[a-z0-9-]+\.supabase\.co|http:\/\/127\.0\.0\.1:\d+)$/.test(CFG.url||'')&&typeof CFG.key==='string'&&CFG.key.length>20;
const sb=configured?window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storageKey:'hatsu.auth'}}):null;
const DOMAIN=CFG.emailDomain||'users.hatsudoya.app';
const PHOTO_MAX_INPUT=15*1024*1024, PHOTO_EDGE=1280, PHOTO_TARGET=350*1024;
let activity={items:[],unseen:0},me=null,isAdmin=false,adminData={pending:[],reports:[]},posts=[],view='timeline',filter='all',nextCursor=null,busy=false,register=false,photo=null,photoBusy=false,photoSeq=0,timer,selectedAvatar='🌱';
const photoUrls=new Map();
let draft={text:'',category:'daily',clientId:crypto.randomUUID()};

// Supabase の英語のエラーを、画面に出せる日本語にする。rpc の中で raise した日本語はそのまま通す。
function ja(e){
  const m=String(e?.message||e||'');
  const table=[[/Invalid login credentials/i,'ユーザーIDまたはパスワードが違います。'],[/already (been )?registered|user_already_exists/i,'このユーザーIDは使われています。'],
    [/rate limit|too many requests/i,'試行回数が多すぎます。少し時間をおいてください。'],[/Password should|weak.?password/i,'パスワードが簡単すぎます。12文字以上で、推測されにくいものにしてください。'],
    [/Database error saving new user/i,'登録できませんでした。ユーザーID・名前・同意を確かめてください。'],[/email.*invalid|invalid.*email/i,'登録の設定に問題があります。運営に知らせてください。'],
    [/Email not confirmed/i,'運営側で「メール確認」がオンのままです。運営に知らせてください。'],[/Signups not allowed/i,'今は新しい登録を受け付けていません。'],
    [/Failed to fetch|NetworkError|Load failed|network/i,'通信できませんでした。電波を確かめて、もう一度試してください。'],[/JWT expired|refresh_token/i,'ログインの期限が切れました。もう一度ログインしてください。'],
    [/permission denied/i,'この操作はできません。'],[/Payload too large|exceeded the maximum/i,'写真が大きすぎます。別の写真を選んでください。']];
  for(const [re,t] of table)if(re.test(m))return t;
  return m||'処理に失敗しました。';
}
async function rpc(fn,args={}){const {data,error}=await sb.rpc(fn,args);if(error)throw new Error(ja(error));return data;}
const photos=()=>sb.storage.from('photos');
const emailOf=handle=>`${handle}@${DOMAIN}`;

function notify(message){clearTimeout(timer);$('toast').textContent=message;$('toast').hidden=false;timer=setTimeout(()=>{$('toast').hidden=true},6000);}
async function action(fn,errorId){if(busy)return;busy=true;document.body.setAttribute('aria-busy','true');document.querySelectorAll('button[type=submit]').forEach(b=>b.disabled=true);try{await fn();}catch(e){const msg=ja(e);if(errorId&&$(errorId))$(errorId).textContent=msg;else notify(msg);}finally{busy=false;document.body.removeAttribute('aria-busy');document.querySelectorAll('button[type=submit]').forEach(b=>b.disabled=false);updateCount();}}
function saveDraft(){if(!me)return;try{sessionStorage.setItem('hatsu.pwa.draft.'+me.id,JSON.stringify(draft));}catch{}}
function restoreDraft(){draft={text:'',category:'daily',clientId:crypto.randomUUID()};try{const d=JSON.parse(sessionStorage.getItem('hatsu.pwa.draft.'+me.id));if(d&&typeof d.text==='string'&&Object.hasOwn(categories,d.category)&&/^[a-zA-Z0-9-]{1,64}$/.test(d.clientId))draft=d;}catch{}}
function clearPhoto(){if(photo?.url)URL.revokeObjectURL(photo.url);photo=null;photoSeq++;photoBusy=false;}
function policy(){return `<div class="policy"><h3>このテスト版について</h3><p>本人にとって初めてのことを自慢し、称えあうSNSの、友だち向けテスト版です。App Storeのアプリではなく、ホーム画面に追加して使うWebアプリです。</p><h3>利用ルール</h3><p>危険行為、脅迫、差別、嫌がらせ、性的な内容、個人情報の暴露、権利侵害を禁止します。権利のある写真だけを使ってください。すべての投稿は、運営が確認してから、ほかの人に表示します。</p><h3>保存・削除</h3><p>プロフィール・投稿・写真・ドヤ・ブロック・通報を、Supabase（データベースのサービス）に保存します。写真は送る前にこの端末で縮小し、撮影場所などの情報（EXIF）を取り除きます。写真は非公開の置き場にあり、表示してよい人にだけ、期限つきのリンクで見せます。広告・追跡はありません。設定から、アカウントと関連データをいつでも削除できます。</p><h3>ログイン</h3><p>メールアドレスは使いません。ユーザーIDとパスワードだけです。<b>パスワードを忘れると、元に戻せません。</b>ほかのサービスで使っていないパスワードにしてください。</p><h3>連絡先と運営</h3><p>通報は運営のキューに届き、確認して対応します。困ったことがあれば、このアプリを紹介した人に直接伝えてください。</p><h3>料金</h3><p>無料です。課金・投げ銭はありません。</p></div>`;}
function modal(title,html){$('modal-title').textContent=title;$('modal-content').innerHTML=html;if(!$('modal').open)$('modal').showModal();}
function closeModal(){$('modal').close();}
const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent), standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
function installHint(){return isIOS&&!standalone?'<p class="install-hint">📲 <b>Safari</b>の共有ボタン（□に↑）→「ホーム画面に追加」で、アプリとして使えます。</p>':'';}

function render(){
if(!configured){$('app').innerHTML=`<section class="card"><h2>まだ準備中です</h2><p class="caption">運営がSupabaseの接続先（config.js）を入れると使えるようになります。</p></section>`;return;}
if(!me){$('app').innerHTML=`<div class="welcome"><section class="hero"><span class="eyebrow">A LITTLE FIRST, A LITTLE PROUD.</span><h1>はじめての自分に、<br>ちょっとドヤ。</h1><p>世界初じゃなくて、わたし初。<br>その一歩を、自分らしく残していこう。</p><span class="medal" aria-hidden="true">🏵️</span><p>友だちどうしで試している、テスト版です。</p>${installHint()}</section><section class="card"><div class="auth-tabs"><button data-auth-tab="login" class="${register?'':'active'}">ログイン</button><button data-auth-tab="register" class="${register?'active':''}">はじめて登録</button></div><h2>${register?'最初の一歩を、ここから。':'おかえりなさい。'}</h2><p class="caption">メールアドレスは要りません。ユーザーIDとパスワードだけで使えます。</p><form id="auth-form"><label for="handle">ユーザーID</label><input id="handle" name="handle" required minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]{3,24}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="半角英数字・_、3〜24文字">${register?'<label for="name">呼ばれたい名前</label><input id="name" name="name" required maxlength="20" placeholder="20文字まで">':''}<label for="password">パスワード</label><input type="password" id="password" name="password" required minlength="12" maxlength="72" autocomplete="${register?'new-password':'current-password'}" placeholder="12文字以上">${register?'<p class="small">⚠ パスワードを忘れると元に戻せません。ほかで使っていないものにして、控えておいてください。</p><label class="check"><input type="checkbox" id="accepted" required>利用ルールとプライバシー説明に同意します。</label><button type="button" class="link" data-action="policy">説明を読む</button>':''}<p class="error" id="auth-error" role="alert"></p><button class="primary full" type="submit">${register?'登録してはじめる':'ログイン'}</button></form></section></div>`;return;}
const nav=[['timeline','⌂ みんな'],['profile','☺ わたし'],...(isAdmin?[['admin','🛡 運営']]:[]),['settings','⚙ 設定']];
const adminCount=adminData.pending.length+adminData.reports.length;
$('app').innerHTML=`<div class="layout"><aside class="side"><nav class="nav" aria-label="ナビゲーション">${nav.map(([key,label])=>`<button data-view="${key}" class="${view===key?'active':''}" ${view===key?'aria-current="page"':''}>${label}${key==='profile'&&activity.unseen?` <span class="new-count" aria-label="新しく届いたドヤ${activity.unseen}件">${activity.unseen}</span>`:''}${key==='admin'&&adminCount?` <span class="new-count" aria-label="確認待ち${adminCount}件">${adminCount}</span>`:''}</button>`).join('')}</nav><p class="caption">世界初じゃなくて、わたし初。<br>小さな一歩に、大きな拍手を。</p></aside><div class="main-column">${view==='settings'?settingsHTML():view==='admin'?adminHTML():feedHTML()}</div></div>`;
if(view==='timeline'||view==='profile'){$('post-text').value=draft.text;$('post-category').value=draft.category;photoPreview();updateCount();}
}
function feedHTML(){return `${view==='profile'?`<section class="card"><div class="profile-top"><span class="avatar">${esc(me.avatar)}</span><button class="secondary" data-action="profile">プロフィールを編集</button></div><h2 class="author-name">${esc(me.name)}</h2><p class="small">@${esc(me.handle)}</p><p class="profile-bio">${esc(me.bio)}</p></section>${activityHTML()}`:`<section class="hero compact-hero"><span class="eyebrow">世界初じゃなくて、わたし初。</span><h1>はじめてを、ほめあおう。</h1><p>大きなことじゃなくていい。今日の一歩を、ちょっと自慢。</p></section>`}<section class="card"><h2 class="compose-title">✦ 今日の「はじめて」は？</h2><form id="post-form"><label class="small" for="post-text">初めてやったこと（280文字まで）</label><textarea id="post-text" maxlength="560" rows="3" placeholder="今日初めて、ひとりで喫茶店に入った。"></textarea><div id="preview" hidden><img id="photo-preview" alt="添付する写真"><button type="button" class="link" data-action="remove-photo">写真を外す</button></div><div class="compose-tools"><div class="left"><label class="file-label">▧ 写真<input id="photo-input" type="file" accept="image/*"></label><label for="post-category" hidden>カテゴリ</label><select id="post-category">${Object.entries(categories).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div><div class="submit-group"><span class="count" id="count">0 / 280</span><button class="primary" type="submit" id="submit-post">初ドヤする ↗</button></div></div><p class="small">写真は任意・1枚。送る前にこの端末で縮小し、撮影場所などの情報を消します。</p><p class="error" id="post-error" role="alert"></p></form></section><h2 class="feed-title">${view==='profile'?'わたし':'みんな'}の小さな一歩 ✦</h2><div class="filters" role="group" aria-label="カテゴリ">${Object.entries({all:'すべて',...categories}).map(([key,label])=>`<button class="filter ${filter===key?'active':''}" data-filter="${key}" aria-pressed="${filter===key}">${label}</button>`).join('')}</div><p class="small">確認待ちの投稿は、運営が確認するまで自分だけに表示されます。</p><div id="feed">${posts.length?posts.map(p=>postHTML(p)).join(''):'<div class="empty"><span>🌱</span>あなたの一歩を、ここから。<br>小さな「はじめて」を残してみよう。</div>'}</div>${nextCursor?'<button class="secondary load-more" data-action="more">続きを読み込む</button>':''}`;}
function activityHTML(){const label=k=>reactions[k]||k;return `<section class="card activity" aria-labelledby="activity-title"><h2 id="activity-title">届いたドヤ${activity.unseen?` <span class="new-count">新しく${activity.unseen}件</span>`:''}</h2>${activity.items.length?`<ul>${activity.items.slice(0,20).map(i=>`<li class="${i.unseen?'unseen':''}"><span class="avatar">${esc(i.from.avatar)}</span><div><b>${esc(i.from.name)}</b> さんから「${esc(label(i.kind))}」<p class="small">${esc(i.postText)} · ${esc(new Date(i.createdAt).toLocaleString('ja-JP'))}</p></div></li>`).join('')}</ul>`:'<p class="caption">まだ届いていません。投稿が確認されてみんなに表示されると、ここに拍手が届きます。</p>'}</section>`;}
function photoTag(p){if(!p.hasPhoto)return '';const url=photoUrls.get(p.photoPath)?.url;return url?`<img class="post-photo" src="${esc(url)}" alt="投稿に添付した写真" loading="lazy">`:'<p class="small photo-missing">▧ 写真を読み込めませんでした</p>';}
function postHTML(p,admin=false){return `<article class="card post" data-id="${p.id}"><header class="author"><span class="avatar">${esc(p.author.avatar)}</span><div class="author-info"><b class="author-name">${esc(p.author.name)}</b><p class="author-meta">@${esc(p.author.handle)} · ${esc(new Date(p.createdAt).toLocaleString('ja-JP'))}${p.isMine?' · あなた':''}</p></div></header><p class="body">${esc(p.text)}</p><span class="tag">${categories[p.category]}</span>${p.status==='pending'&&!admin?'<p class="pending">◷ 確認待ち · 自分だけに表示<br>運営が確認すると、みんなに表示されます。</p>':''}${photoTag(p)}${admin?'':`<div class="reactions" role="group" aria-label="初挑戦を称える">${Object.entries(reactions).map(([k,label])=>`<button class="reaction" data-react="${k}" data-post="${p.id}" aria-pressed="${p.myReactions.includes(k)}">${label} <b>${p.counts[k]||0}</b></button>`).join('')}</div><div class="post-actions">${p.isMine?`<button data-delete="${p.id}">投稿を削除</button>`:`<button data-report="${p.id}">通報する</button><button data-block="${p.id}">ブロック</button>`}</div>`}</article>`;}
function adminHTML(){const {pending,reports}=adminData;return `<section class="card"><h2>運営：確認待ち ${pending.length}件</h2><p class="caption">承認すると、みんなのタイムラインに出ます。非表示にすると写真も消えます。</p></section>${pending.map(p=>`${postHTML(p,true)}<div class="admin-actions"><button class="primary" data-admin-status="published" data-post="${p.id}">承認する</button><button class="secondary" data-admin-status="removed" data-post="${p.id}">非表示にする</button><button class="danger-link" data-admin-suspend="${p.author.id}" data-name="${esc(p.author.name)}">この人を停止</button></div>`).join('')||'<p class="caption admin-empty">確認待ちの投稿はありません。</p>'}<section class="card"><h2>運営：通報 ${reports.length}件</h2></section>${reports.map(r=>`<div class="report-note">⚑ ${esc(r.reporter.name)} さんから「${esc(reasons[r.reason]||r.reason)}」${r.detail?`：${esc(r.detail)}`:''} · ${esc(new Date(r.createdAt).toLocaleString('ja-JP'))}</div>${r.post?postHTML(r.post,true):'<p class="caption">（投稿はもうありません）</p>'}${r.post?`<div class="admin-actions"><button class="secondary" data-admin-status="published" data-post="${r.post.id}">問題なし</button><button class="primary" data-admin-status="removed" data-post="${r.post.id}">非表示にする</button><button class="danger-link" data-admin-suspend="${r.post.author.id}" data-name="${esc(r.post.author.name)}">この人を停止</button></div>`:''}`).join('')||'<p class="caption admin-empty">未対応の通報はありません。</p>'}<button class="secondary load-more" data-action="admin-refresh">最新にする</button>`;}
function settingsHTML(){return `<section class="card"><h2>設定と安心</h2><p class="caption">ログイン中：@${esc(me.handle)}</p><div class="setting-row"><p>プロフィール<small>名前・マーク・ひとこと</small></p><button class="secondary" data-action="profile">編集</button></div><div class="setting-row"><p>ブロックしたユーザー<small>解除すると再び表示します</small></p><button class="secondary" data-action="blocks">確認</button></div><div class="setting-row"><p>利用ルール・保存先</p><button class="secondary" data-action="policy">読む</button></div><div class="setting-row"><p>ログアウト<small>もう一度入るにはIDとパスワードが要ります</small></p><button class="secondary" data-action="logout">ログアウト</button></div></section><section class="card"><h2>アカウントとデータの削除</h2><p class="caption">プロフィール・投稿・写真・ドヤ・ブロック・通報をすべて削除します。</p><button class="danger full" data-action="delete-account">アカウントを削除する</button></section>`;}

// 写真の場所 → 期限つきリンク。期限の10分前には取り直す。
async function signPhotos(list){
  const now=Date.now(), need=[...new Set(list.filter(p=>p.photoPath).map(p=>p.photoPath))].filter(path=>!(photoUrls.get(path)?.until>now));
  if(!need.length)return;
  const {data,error}=await photos().createSignedUrls(need,3600);
  if(error)return;
  for(const item of data||[])if(item.signedUrl)photoUrls.set(item.path,{url:item.signedUrl,until:now+50*60*1000});
}
async function loadActivity(){try{activity=await rpc('activity');}catch{activity={items:[],unseen:0};}}
async function loadAdmin(){if(!isAdmin)return;try{adminData=await rpc('admin_queue');await signPhotos([...adminData.pending,...adminData.reports.map(r=>r.post).filter(Boolean)]);}catch{adminData={pending:[],reports:[]};}}
async function reload(more=false){
  if(view==='admin'){await loadAdmin();render();return;}
  const r=await rpc('timeline',{p_mine:view==='profile',p_category:filter,p_before:more&&nextCursor?nextCursor:null});
  posts=more?[...posts,...r.posts.filter(p=>!posts.some(x=>x.id===p.id))]:r.posts;nextCursor=r.nextCursor;
  await signPhotos(r.posts);
  if(!more)await Promise.all([loadActivity(),loadAdmin()]);
  render();
  if(view==='profile'&&activity.unseen)rpc('activity_seen').then(()=>{activity.unseen=0;document.querySelectorAll('.nav .new-count').forEach(x=>{if(x.closest('[data-view=profile]'))x.remove();});}).catch(()=>{});
}
async function loadMe(){const r=await rpc('me');me=r.user;isAdmin=r.isAdmin===true;}
function updateCount(){if(!$('post-text'))return;const n=Array.from($('post-text').value).length;$('count').textContent=`${n} / 280`;$('count').classList.toggle('over',n>280);$('submit-post').disabled=busy||photoBusy||n>280||!$('post-text').value.trim();}
function photoPreview(){if(!$('preview'))return;$('preview').hidden=!photo;if(photo)$('photo-preview').src=photo.url;else $('photo-preview').removeAttribute('src');}
function getPost(id){return posts.find(p=>p.id===id)||adminData.pending.find(p=>p.id===id);}
function replacePost(next){posts=posts.map(p=>p.id===next.id?next:p);}

// 写真を、最長辺1280pxのJPEG（だいたい350KB以下）に作り直す。作り直すので撮影場所などの情報は残らない。
async function decode(file){
  try{return await createImageBitmap(file,{imageOrientation:'from-image'});}catch{}
  const url=URL.createObjectURL(file);
  try{const img=new Image();img.src=url;await img.decode();return img;}finally{URL.revokeObjectURL(url);}
}
async function toJpeg(file){
  if(file.size>PHOTO_MAX_INPUT)throw new Error('写真は15MBまでです。');
  if(file.type&&!file.type.startsWith('image/'))throw new Error('写真を選んでください。');
  let img;try{img=await decode(file);}catch{throw new Error('この写真は読み込めませんでした。別の写真を選んでください。');}
  const w=img.width||img.naturalWidth,h=img.height||img.naturalHeight;
  if(!w||!h)throw new Error('この写真は読み込めませんでした。');
  if(w*h>40000000)throw new Error('写真の画素数が大きすぎます。');
  const scale=Math.min(1,PHOTO_EDGE/Math.max(w,h)),canvas=document.createElement('canvas');
  canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
  img.close?.();
  let blob;
  for(const q of [0.85,0.76,0.67,0.58,0.5]){blob=await new Promise(res=>canvas.toBlob(res,'image/jpeg',q));if(blob&&blob.size<=PHOTO_TARGET)break;}
  if(!blob)throw new Error('写真を変換できませんでした。');
  return blob;
}

async function signOutLocal(){try{await sb.auth.signOut({scope:'local'});}catch{}me=null;isAdmin=false;posts=[];activity={items:[],unseen:0};adminData={pending:[],reports:[]};clearPhoto();photoUrls.clear();view='timeline';}

$('about').onclick=()=>modal('初ドヤのテスト版について',policy());$('close-modal').onclick=closeModal;
document.addEventListener('input',event=>{if(event.target.id==='post-text'){draft.text=event.target.value;saveDraft();updateCount();}});
document.addEventListener('change',async event=>{if(event.target.id==='post-category'){draft.category=event.target.value;saveDraft();}if(event.target.id==='photo-input'){
 const file=event.target.files[0];if(!file)return;const seq=++photoSeq;$('post-error').textContent='';photoBusy=true;updateCount();
 try{const blob=await toJpeg(file);if(seq===photoSeq){if(photo?.url)URL.revokeObjectURL(photo.url);photo={blob,url:URL.createObjectURL(blob)};photoPreview();}}
 catch(e){if(seq===photoSeq&&$('post-error'))$('post-error').textContent=ja(e);}
 finally{if(seq===photoSeq){photoBusy=false;updateCount();}if(event.target)event.target.value='';}
}});
document.addEventListener('submit',event=>{event.preventDefault();const form=event.target;
 if(form.id==='auth-form')action(async()=>{
   const handle=$('handle').value.trim().toLowerCase(),password=$('password').value,name=($('name')?.value||'').trim();
   if(!/^[a-z0-9_]{3,24}$/.test(handle))throw new Error('ユーザーIDは半角英数字・_の3〜24文字です。');
   if(password.length<12)throw new Error('パスワードは12文字以上にしてください。');
   if(register){
     if(!name||Array.from(name).length>20)throw new Error('名前は1〜20文字です。');
     if($('accepted')?.checked!==true)throw new Error('利用ルールとプライバシー説明への同意が必要です。');
     const {data,error}=await sb.auth.signUp({email:emailOf(handle),password,options:{data:{handle,name,accepted_terms:true}}});
     if(error)throw error;
     if(!data.session)throw new Error('Email not confirmed');
   }else{
     const {error}=await sb.auth.signInWithPassword({email:emailOf(handle),password});
     if(error)throw error;
   }
   try{await loadMe();}catch(e){await signOutLocal();throw e;}
   restoreDraft();view='timeline';await reload();
 },'auth-error');
 if(form.id==='post-form'){if(photoBusy||busy)return;draft.text=$('post-text').value;saveDraft();if(!draft.text.trim()||Array.from(draft.text).length>280)return;action(async()=>{
   let path=null;
   if(photo){path=`${me.id}/${draft.clientId}.jpg`;const {error}=await photos().upload(path,photo.blob,{contentType:'image/jpeg',upsert:true,cacheControl:'3600'});if(error)throw error;}
   try{await rpc('create_post',{p_text:draft.text,p_category:draft.category,p_client_id:draft.clientId,p_with_photo:!!path});}
   catch(e){if(path&&!/通信/.test(e.message))photos().remove([path]).catch(()=>{});throw e;}
   draft={text:'',category:draft.category,clientId:crypto.randomUUID()};clearPhoto();saveDraft();filter='all';await reload();notify('送りました。運営が確認するまで、自分だけに表示されます。');
 },'post-error');}
 if(form.id==='profile-form')action(async()=>{const r=await rpc('update_profile',{p_name:$('edit-name').value,p_bio:$('edit-bio').value,p_avatar:selectedAvatar});me=r.user;closeModal();await reload();},'profile-error');
 if(form.id==='report-form')action(async()=>{const r=await rpc('report_post',{p_post:form.dataset.post,p_reason:$('reason').value,p_detail:$('detail').value});closeModal();notify(r.notice);},'report-error');
 if(form.id==='delete-account-form')action(async()=>{
   const {error}=await sb.auth.signInWithPassword({email:emailOf(me.handle),password:$('delete-password').value});
   if(error)throw new Error(/Invalid login/i.test(error.message)?'確認用パスワードが違います。':ja(error));
   for(;;){const {data,error:listError}=await photos().list(me.id,{limit:100});if(listError)throw listError;if(!data?.length)break;const {error:rmError}=await photos().remove(data.map(o=>`${me.id}/${o.name}`));if(rmError)throw rmError;if(data.length<100)break;}
   await rpc('delete_my_account');
   try{sessionStorage.removeItem('hatsu.pwa.draft.'+me.id);}catch{}
   await signOutLocal();draft={text:'',category:'daily',clientId:crypto.randomUUID()};closeModal();render();notify('アカウントと関連データを削除しました。');
 },'delete-error');
});
document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;
 if(b.dataset.authTab){register=b.dataset.authTab==='register';render();}
 if(b.dataset.view)action(async()=>{view=b.dataset.view;filter='all';if(view==='settings')render();else await reload();window.scrollTo(0,0);});
 if(b.dataset.filter)action(async()=>{filter=b.dataset.filter;await reload();document.querySelector(`[data-filter="${filter}"]`)?.focus({preventScroll:true});});
 if(b.dataset.action==='policy')modal('利用ルールと保存先',policy());
 if(b.dataset.action==='remove-photo'){clearPhoto();photoPreview();updateCount();}
 if(b.dataset.action==='more')action(()=>reload(true));
 if(b.dataset.action==='admin-refresh')action(()=>reload());
 if(b.dataset.action==='profile'){selectedAvatar=me.avatar;modal('あなたらしいプロフィールに。',`<form id="profile-form"><label for="edit-name">呼ばれたい名前・20文字まで</label><input id="edit-name" required maxlength="20" value="${esc(me.name)}"><label>あなたのマーク</label><div class="avatars">${avatars.map((a,i)=>`<button type="button" data-avatar="${i}" aria-label="マーク${i+1}" aria-pressed="${a===me.avatar}">${a}</button>`).join('')}</div><label for="edit-bio">ひとこと・100文字まで</label><textarea id="edit-bio" maxlength="100">${esc(me.bio)}</textarea><p class="error" id="profile-error" role="alert"></p><button class="primary full" type="submit">保存する</button></form>`);}
 if(b.dataset.avatar!==undefined){selectedAvatar=avatars[+b.dataset.avatar];document.querySelectorAll('[data-avatar]').forEach(x=>x.setAttribute('aria-pressed',String(avatars[+x.dataset.avatar]===selectedAvatar)));}
 if(b.dataset.react)action(async()=>{const p=getPost(b.dataset.post);replacePost(await rpc('set_reaction',{p_post:p.id,p_kind:b.dataset.react,p_enabled:!p.myReactions.includes(b.dataset.react)}));render();});
 if(b.dataset.delete){modal('この初ドヤを削除しますか？',`<p class="caption">投稿と写真、関連するドヤを削除します。この操作は取り消せません。</p><div class="dialog-actions"><button class="secondary" data-action="cancel">残しておく</button><button class="danger" data-confirm-delete="${b.dataset.delete}">削除する</button></div>`);}
 if(b.dataset.confirmDelete)action(async()=>{const r=await rpc('delete_post',{p_id:b.dataset.confirmDelete});if(r.photoPath){await photos().remove([r.photoPath]);photoUrls.delete(r.photoPath);}closeModal();await reload();notify('投稿を削除しました。');});
 if(b.dataset.action==='cancel')closeModal();
 if(b.dataset.report){modal('投稿を通報する',`<p class="caption">運営の確認キューに届きます。相手には知らされません。</p><form id="report-form" data-post="${b.dataset.report}"><label for="reason">理由</label><select id="reason">${Object.entries(reasons).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select><label for="detail">補足（任意・500文字まで）</label><textarea id="detail" maxlength="500"></textarea><p class="error" id="report-error" role="alert"></p><button type="submit" class="primary full">運営に通報する</button></form>`);}
 if(b.dataset.block){const p=getPost(b.dataset.block);modal('ユーザーをブロックしますか？',`<p class="caption">${esc(p.author.name)} さんの投稿と写真を非表示にします。相手にもあなたの投稿を表示しません。設定から解除できます。</p><div class="dialog-actions"><button class="secondary" data-action="cancel">やめる</button><button class="danger" data-confirm-block="${p.author.id}">ブロックする</button></div>`);}
 if(b.dataset.confirmBlock)action(async()=>{await rpc('set_block',{p_user:b.dataset.confirmBlock,p_blocked:true});closeModal();await reload();notify('ユーザーをブロックしました。');});
 if(b.dataset.action==='blocks')action(async()=>{const r=await rpc('list_blocks');modal('ブロックしたユーザー',r.users.length?r.users.map(u=>`<div class="setting-row"><p>${esc(u.avatar)} ${esc(u.name)}</p><button class="secondary" data-unblock="${u.id}">解除</button></div>`).join(''):'<p class="caption">ブロックしたユーザーはいません。</p>');});
 if(b.dataset.unblock)action(async()=>{await rpc('set_block',{p_user:b.dataset.unblock,p_blocked:false});closeModal();notify('ブロックを解除しました。');});
 if(b.dataset.adminStatus)action(async()=>{const r=await rpc('admin_set_status',{p_post:b.dataset.post,p_status:b.dataset.adminStatus});if(r.removedPhoto){await photos().remove([r.removedPhoto]).catch(()=>{});photoUrls.delete(r.removedPhoto);}await reload();notify(b.dataset.adminStatus==='published'?'承認しました。みんなに表示されます。':'非表示にしました。');});
 if(b.dataset.adminSuspend){modal('このユーザーを停止しますか？',`<p class="caption">${esc(b.dataset.name)} さんはログインしても何もできなくなり、投稿もみんなから見えなくなります。解除はSupabaseの画面から行います。</p><div class="dialog-actions"><button class="secondary" data-action="cancel">やめる</button><button class="danger" data-confirm-suspend="${esc(b.dataset.adminSuspend)}">停止する</button></div>`);}
 if(b.dataset.confirmSuspend)action(async()=>{await rpc('admin_suspend',{p_user:b.dataset.confirmSuspend,p_suspended:true});closeModal();await reload();notify('停止しました。');});
 if(b.dataset.action==='logout')action(async()=>{await signOutLocal();render();});
 if(b.dataset.action==='delete-account')modal('アカウントの完全削除',`<p class="caption">プロフィール、投稿、写真、ドヤ、ブロック、通報を削除します。取り消せません。</p><form id="delete-account-form"><label for="delete-password">現在のパスワード</label><input id="delete-password" type="password" required autocomplete="current-password"><label class="check"><input type="checkbox" required>削除される範囲を確認しました。</label><p class="error" id="delete-error" role="alert"></p><button class="danger full" type="submit">アカウントとデータを削除</button></form>`);
});
// アプリに戻ってきたら、届いたドヤと運営の件数を取り直す。
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&me&&!busy&&!$('modal').open&&!document.activeElement?.matches('textarea,input'))action(()=>reload());});

(async()=>{
  if(!configured){render();return;}
  try{const {data}=await sb.auth.getSession();if(data.session){await loadMe();restoreDraft();await reload();return;}}
  catch(e){if(/プロフィール|停止|ログイン/.test(e.message)){await signOutLocal();render();notify(e.message);return;}render();notify(ja(e));return;}
  render();
})();
})();
