-- 初ドヤ（友だち向けPWA版）の Supabase 構成。
-- Supabase の SQL Editor にまるごと貼って1回実行する。何度実行しても同じ状態になる。
--
-- 方針:
--   * 表はすべて hatsu スキーマに置く（Supabase の REST からは直接見えない）。
--   * 画面からの操作は public の関数（rpc）だけを通す。関数の中で本人・ブロック・停止・公開状態を毎回確かめる。
--   * 写真は非公開の photos バケット。見られるのは「見てよい投稿」の写真だけ。
--   * 新しい投稿はすべて「確認待ち」。運営（is_admin のアカウント）がアプリ内で承認すると、みんなに出る。

create schema if not exists hatsu;
revoke all on schema hatsu from public, anon, authenticated;

create table if not exists hatsu.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  name text not null check (char_length(name) between 1 and 20),
  avatar text not null default '🌱' check (avatar in ('🌱','☕','🐈','🌼','🦉','🍊')),
  bio text not null default '' check (char_length(bio) <= 100),
  terms_version text not null,
  is_admin boolean not null default false,
  suspended boolean not null default false,
  activity_seen_at timestamptz not null default 'epoch',
  created_at timestamptz not null default now()
);

create table if not exists hatsu.posts (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  author_id uuid not null references hatsu.profiles(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 280),
  category text not null check (category in ('daily','food','challenge','outing','hobby')),
  photo_path text,
  status text not null default 'pending' check (status in ('pending','published','removed')),
  client_id text not null check (client_id ~ '^[a-zA-Z0-9-]{1,64}$'),
  created_at timestamptz not null default now(),
  unique (author_id, client_id)
);
create index if not exists posts_feed on hatsu.posts (seq desc);
create index if not exists posts_author on hatsu.posts (author_id, seq desc);

create table if not exists hatsu.reactions (
  post_id uuid not null references hatsu.posts(id) on delete cascade,
  user_id uuid not null references hatsu.profiles(id) on delete cascade,
  kind text not null check (kind in ('doya','step','relate')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, kind)
);
create index if not exists reactions_recent on hatsu.reactions (post_id, created_at desc);

create table if not exists hatsu.blocks (
  user_id uuid not null references hatsu.profiles(id) on delete cascade,
  blocked_id uuid not null references hatsu.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked_id),
  check (user_id <> blocked_id)
);

create table if not exists hatsu.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references hatsu.profiles(id) on delete cascade,
  post_id uuid not null references hatsu.posts(id) on delete cascade,
  reason text not null check (reason in ('harassment','danger','sexual','privacy','spam','other')),
  detail text not null default '' check (char_length(detail) <= 500),
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  unique (reporter_id, post_id)
);

alter table hatsu.profiles enable row level security;
alter table hatsu.posts enable row level security;
alter table hatsu.reactions enable row level security;
alter table hatsu.blocks enable row level security;
alter table hatsu.reports enable row level security;
revoke all on all tables in schema hatsu from public, anon, authenticated;

-- ───────── 内部の道具（画面からは呼べない） ─────────

create or replace function hatsu.ms(t timestamptz) returns bigint
language sql immutable as $$ select (extract(epoch from t) * 1000)::bigint $$;

-- ログイン中で、停止されていない本人のIDを返す。違えば止める。
create or replace function hatsu.me_id() returns uuid
language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := auth.uid(); s boolean;
begin
  if v is null then raise exception 'ログインが必要です。' using errcode = '28000'; end if;
  select suspended into s from hatsu.profiles where id = v;
  if s is null then raise exception 'プロフィールが見つかりません。' using errcode = 'P0002'; end if;
  if s then raise exception 'このアカウントは停止中です。' using errcode = '42501'; end if;
  return v;
end $$;

create or replace function hatsu.admin_id() returns uuid
language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id();
begin
  if not (select is_admin from hatsu.profiles where id = v) then
    raise exception '運営だけが使える操作です。' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function hatsu.blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select exists (select 1 from hatsu.blocks
                 where (user_id = a and blocked_id = b) or (user_id = b and blocked_id = a))
$$;

-- viewer がこの投稿を見てよいか（公開済み・相手が停止されていない・ブロック関係なし。自分の確認待ちは見える）
create or replace function hatsu.post_visible(viewer uuid, pid uuid) returns boolean
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select exists (
    select 1 from hatsu.posts p join hatsu.profiles a on a.id = p.author_id
    where p.id = pid and not a.suspended
      and (p.status = 'published' or (p.status = 'pending' and p.author_id = viewer))
      and not hatsu.blocked_between(viewer, p.author_id))
$$;

create or replace function hatsu.profile_json(p hatsu.profiles) returns json
language sql stable as $$
  select json_build_object('id', p.id, 'handle', p.handle, 'name', p.name, 'avatar', p.avatar, 'bio', p.bio)
$$;

create or replace function hatsu.post_json(viewer uuid, pid uuid) returns json
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select json_build_object(
    'id', p.id, 'seq', p.seq, 'author', hatsu.profile_json(a), 'text', p.text, 'category', p.category,
    'status', p.status, 'createdAt', hatsu.ms(p.created_at),
    'hasPhoto', p.photo_path is not null, 'photoPath', p.photo_path,
    'counts', json_build_object(
      'doya',   (select count(*) from hatsu.reactions r where r.post_id = p.id and r.kind = 'doya'),
      'step',   (select count(*) from hatsu.reactions r where r.post_id = p.id and r.kind = 'step'),
      'relate', (select count(*) from hatsu.reactions r where r.post_id = p.id and r.kind = 'relate')),
    'myReactions', coalesce((select json_agg(r.kind order by r.kind) from hatsu.reactions r
                             where r.post_id = p.id and r.user_id = viewer), '[]'::json),
    'isMine', p.author_id = viewer)
  from hatsu.posts p join hatsu.profiles a on a.id = p.author_id
  where p.id = pid
$$;

-- 新しく登録した人のプロフィールを作る。ID・名前・同意がそろっていなければ登録自体を止める。
create or replace function hatsu.on_new_user() returns trigger
language plpgsql security definer set search_path = hatsu, pg_temp as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
        h text := lower(coalesce(m->>'handle', ''));
        n text := btrim(coalesce(m->>'name', ''));
begin
  if coalesce(m->>'accepted_terms', '') <> 'true' then
    raise exception '利用ルールへの同意が必要です。';
  end if;
  if h !~ '^[a-z0-9_]{3,24}$' then raise exception 'ユーザーIDは半角英数字・_の3〜24文字です。'; end if;
  if char_length(n) not between 1 and 20 then raise exception '名前は1〜20文字です。'; end if;
  insert into hatsu.profiles (id, handle, name, terms_version) values (new.id, h, n, '2026-10-19-pwa-v1');
  return new;
end $$;

drop trigger if exists hatsu_on_new_user on auth.users;
create trigger hatsu_on_new_user after insert on auth.users
  for each row execute function hatsu.on_new_user();

revoke all on all functions in schema hatsu from public, anon, authenticated;

-- ───────── 写真の置き場（非公開） ─────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

-- ストレージの決まりから呼ぶので public に置く。引数は写真の場所だけで、見る人は常に本人（auth.uid()）。
create or replace function public.hatsu_can_view_photo(object_name text) returns boolean
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select auth.uid() is not null and (
    split_part(object_name, '/', 1) = auth.uid()::text
    or exists (select 1 from hatsu.profiles where id = auth.uid() and is_admin and not suspended)
    or exists (select 1 from hatsu.posts p where p.photo_path = object_name and hatsu.post_visible(auth.uid(), p.id)))
$$;

create or replace function public.hatsu_can_upload(object_name text) returns boolean
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select auth.uid() is not null
    and split_part(object_name, '/', 1) = auth.uid()::text
    and exists (select 1 from hatsu.profiles where id = auth.uid() and not suspended)
$$;

create or replace function public.hatsu_can_remove(object_name text) returns boolean
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select auth.uid() is not null and (
    split_part(object_name, '/', 1) = auth.uid()::text
    or exists (select 1 from hatsu.profiles where id = auth.uid() and is_admin and not suspended))
$$;

drop policy if exists hatsu_photos_select on storage.objects;
drop policy if exists hatsu_photos_insert on storage.objects;
drop policy if exists hatsu_photos_update on storage.objects;
drop policy if exists hatsu_photos_delete on storage.objects;
create policy hatsu_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.hatsu_can_view_photo(name));
create policy hatsu_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.hatsu_can_upload(name));
create policy hatsu_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.hatsu_can_upload(name))
  with check (bucket_id = 'photos' and public.hatsu_can_upload(name));
create policy hatsu_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.hatsu_can_remove(name));

-- ───────── 画面から呼ぶ窓口（rpc） ─────────

-- 毎日の「のぞき」用。ログイン不要。データは返さない。
create or replace function public.ping() returns json
language sql stable security definer set search_path = hatsu, pg_temp as $$
  select json_build_object('ok', true, 'at', now(), 'posts', (select count(*) from hatsu.posts) >= 0)
$$;

create or replace function public.me() returns json
language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); p hatsu.profiles;
begin
  select * into p from hatsu.profiles where id = v;
  return json_build_object('user', hatsu.profile_json(p), 'isAdmin', p.is_admin,
                           'postCount', (select count(*) from hatsu.posts where author_id = v));
end $$;

create or replace function public.update_profile(p_name text, p_bio text, p_avatar text) returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); n text := btrim(coalesce(p_name, '')); b text := btrim(coalesce(p_bio, ''));
begin
  if char_length(n) not between 1 and 20 then raise exception '名前は1〜20文字で入力してください。'; end if;
  if char_length(b) > 100 then raise exception 'ひとことは100文字までです。'; end if;
  if p_avatar is null or p_avatar not in ('🌱','☕','🐈','🌼','🦉','🍊') then raise exception 'マークを選んでください。'; end if;
  update hatsu.profiles set name = n, bio = b, avatar = p_avatar where id = v;
  return public.me();
end $$;

create or replace function public.timeline(p_mine boolean default false, p_category text default 'all', p_before bigint default null)
returns json language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); result json;
begin
  if p_category is null or p_category not in ('all','daily','food','challenge','outing','hobby') then
    raise exception 'カテゴリが不正です。';
  end if;
  with c as (
    select p.id, p.seq, row_number() over (order by p.seq desc) as rn
    from hatsu.posts p join hatsu.profiles a on a.id = p.author_id
    where (p_before is null or p.seq < p_before) and not a.suspended
      and (p.status = 'published' or (p.status = 'pending' and p.author_id = v))
      and not hatsu.blocked_between(v, p.author_id)
      and (not coalesce(p_mine, false) or p.author_id = v)
      and (p_category = 'all' or p.category = p_category)
    order by p.seq desc limit 51)
  select json_build_object(
    'posts', coalesce(json_agg(hatsu.post_json(v, c.id) order by c.seq desc) filter (where c.rn <= 50), '[]'::json),
    'nextCursor', case when count(*) > 50 then min(c.seq) filter (where c.rn <= 50) end)
  into result from c;
  return result;
end $$;

-- 写真つきなら、先に photos/<自分のID>/<clientId>.jpg に置いてから呼ぶ。同じ clientId の再送は同じ投稿を返す。
create or replace function public.create_post(p_text text, p_category text, p_client_id text, p_with_photo boolean default false)
returns json language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); t text := btrim(coalesce(p_text, '')); ex hatsu.posts; path text; pid uuid;
begin
  if char_length(t) not between 1 and 280 then raise exception '本文は1〜280文字で入力してください。'; end if;
  if p_category is null or p_category not in ('daily','food','challenge','outing','hobby') then raise exception 'カテゴリを選んでください。'; end if;
  if p_client_id is null or p_client_id !~ '^[a-zA-Z0-9-]{1,64}$' then raise exception '投稿IDが不正です。'; end if;
  select * into ex from hatsu.posts where author_id = v and client_id = p_client_id;
  if found then
    if ex.text <> t or ex.category <> p_category or (ex.photo_path is not null) <> coalesce(p_with_photo, false) then
      raise exception '同じ投稿IDに異なる内容は保存できません。' using errcode = '23505';
    end if;
    return hatsu.post_json(v, ex.id);
  end if;
  if (select count(*) from hatsu.posts where author_id = v) >= 100 then
    raise exception '投稿は100件までです。不要な投稿を削除してください。';
  end if;
  if (select count(*) from hatsu.posts where author_id = v and created_at > now() - interval '1 hour') >= 20 then
    raise exception '短い時間に投稿が多すぎます。少し時間をおいてください。';
  end if;
  if t like '%殺してやる%' or t like '%個人情報を晒す%' then
    raise exception '安全な表現に書き直してください。脅迫や個人情報の暴露は投稿できません。';
  end if;
  if coalesce(p_with_photo, false) then
    path := v::text || '/' || p_client_id || '.jpg';
    if not exists (select 1 from storage.objects where bucket_id = 'photos' and name = path) then
      raise exception '写真の保存を確認できませんでした。もう一度送ってください。';
    end if;
  end if;
  insert into hatsu.posts (author_id, text, category, photo_path, client_id)
  values (v, t, p_category, path, p_client_id) returning id into pid;
  return hatsu.post_json(v, pid);
end $$;

-- 写真の場所を返すので、画面側で写真も消す。
create or replace function public.delete_post(p_id uuid) returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); path text;
begin
  delete from hatsu.posts where id = p_id and author_id = v returning photo_path into path;
  if not found then raise exception '自分の投稿だけ削除できます。' using errcode = '42501'; end if;
  return json_build_object('ok', true, 'photoPath', path);
end $$;

create or replace function public.set_reaction(p_post uuid, p_kind text, p_enabled boolean) returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id();
begin
  if p_kind is null or p_kind not in ('doya','step','relate') or p_enabled is null then raise exception 'リアクションが不正です。'; end if;
  if not hatsu.post_visible(v, p_post) then raise exception '投稿が見つかりません。' using errcode = 'P0002'; end if;
  if p_enabled then
    insert into hatsu.reactions (post_id, user_id, kind) values (p_post, v, p_kind) on conflict do nothing;
  else
    delete from hatsu.reactions where post_id = p_post and user_id = v and kind = p_kind;
  end if;
  return hatsu.post_json(v, p_post);
end $$;

create or replace function public.report_post(p_post uuid, p_reason text, p_detail text default '') returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); d text := btrim(coalesce(p_detail, ''));
begin
  if not hatsu.post_visible(v, p_post) then raise exception '投稿が見つかりません。' using errcode = 'P0002'; end if;
  if (select author_id from hatsu.posts where id = p_post) = v then raise exception '自分の投稿は削除できます。'; end if;
  if p_reason is null or p_reason not in ('harassment','danger','sexual','privacy','spam','other') then raise exception '通報理由を選んでください。'; end if;
  if char_length(d) > 500 then raise exception '補足は500文字までです。'; end if;
  insert into hatsu.reports (reporter_id, post_id, reason, detail) values (v, p_post, p_reason, d)
  on conflict (reporter_id, post_id) do nothing;
  return json_build_object('ok', true, 'notice', '運営に通報しました。確認して対応します。');
end $$;

-- 自分の投稿に、ほかの人が付けたドヤ（最新50件）。ブロック・停止中の相手は出ない。
create or replace function public.activity() returns json
language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id(); seen timestamptz; result json;
begin
  select activity_seen_at into seen from hatsu.profiles where id = v;
  with c as (
    select r.kind, r.created_at, p.id as post_id, p.text, u as sender
    from hatsu.reactions r
    join hatsu.posts p on p.id = r.post_id
    join hatsu.profiles u on u.id = r.user_id
    where p.author_id = v and r.user_id <> v and not u.suspended and p.status in ('published','pending')
      and not hatsu.blocked_between(v, r.user_id)
    order by r.created_at desc limit 50)
  select json_build_object(
    'items', coalesce(json_agg(json_build_object(
        'from', hatsu.profile_json(c.sender), 'kind', c.kind, 'postId', c.post_id,
        'postText', left(c.text, 40), 'createdAt', hatsu.ms(c.created_at), 'unseen', c.created_at > seen)
      order by c.created_at desc), '[]'::json),
    'unseen', count(*) filter (where c.created_at > seen))
  into result from c;
  return result;
end $$;

create or replace function public.activity_seen() returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id();
begin
  update hatsu.profiles set activity_seen_at = now() where id = v;
  return json_build_object('ok', true);
end $$;

create or replace function public.list_blocks() returns json
language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id();
begin
  return json_build_object('users', coalesce((
    select json_agg(hatsu.profile_json(u) order by b.created_at desc)
    from hatsu.blocks b join hatsu.profiles u on u.id = b.blocked_id where b.user_id = v), '[]'::json));
end $$;

create or replace function public.set_block(p_user uuid, p_blocked boolean) returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.me_id();
begin
  if p_user is null or p_user = v or not exists (select 1 from hatsu.profiles where id = p_user) then
    raise exception 'このユーザーは指定できません。';
  end if;
  if coalesce(p_blocked, false) then
    insert into hatsu.blocks (user_id, blocked_id) values (v, p_user) on conflict do nothing;
  else
    delete from hatsu.blocks where user_id = v and blocked_id = p_user;
  end if;
  return json_build_object('ok', true);
end $$;

-- 本人のアカウントと関連データ（投稿・反応・ブロック・通報）を消す。写真は画面側が先に消しておく。
-- 停止中でも削除はできる。
create or replace function public.delete_my_account() returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'ログインが必要です。' using errcode = '28000'; end if;
  delete from auth.users where id = v;
  return json_build_object('ok', true, 'deleted', true);
end $$;

-- ───────── 運営（is_admin のアカウントだけ） ─────────

create or replace function public.admin_queue() returns json
language plpgsql stable security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.admin_id();
begin
  return json_build_object(
    'pending', coalesce((select json_agg(hatsu.post_json(v, p.id) order by p.seq)
                         from hatsu.posts p join hatsu.profiles a on a.id = p.author_id
                         where p.status = 'pending' and not a.suspended), '[]'::json),
    'reports', coalesce((select json_agg(json_build_object(
                           'id', r.id, 'reason', r.reason, 'detail', r.detail, 'createdAt', hatsu.ms(r.created_at),
                           'reporter', hatsu.profile_json(u), 'post', hatsu.post_json(v, r.post_id)) order by r.created_at)
                         from hatsu.reports r join hatsu.profiles u on u.id = r.reporter_id
                         where r.status = 'open'), '[]'::json));
end $$;

-- 承認（published）か非表示（removed）。どちらでも、その投稿への通報は対応済みにする。
-- 非表示のときは写真の場所を返すので、画面側で写真を消す。
create or replace function public.admin_set_status(p_post uuid, p_status text) returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.admin_id(); path text;
begin
  if p_status is null or p_status not in ('published','removed') then raise exception '状態が不正です。'; end if;
  select photo_path into path from hatsu.posts where id = p_post;
  if not found then raise exception '投稿が見つかりません。' using errcode = 'P0002'; end if;
  update hatsu.posts set status = p_status,
         photo_path = case when p_status = 'removed' then null else photo_path end
   where id = p_post;
  update hatsu.reports set status = 'resolved' where post_id = p_post and status = 'open';
  return json_build_object('ok', true, 'removedPhoto', case when p_status = 'removed' then path end);
end $$;

create or replace function public.admin_suspend(p_user uuid, p_suspended boolean) returns json
language plpgsql volatile security definer set search_path = hatsu, pg_temp as $$
declare v uuid := hatsu.admin_id();
begin
  if p_user = v then raise exception '自分自身は停止できません。'; end if;
  update hatsu.profiles set suspended = coalesce(p_suspended, true) where id = p_user;
  if not found then raise exception 'ユーザーが見つかりません。' using errcode = 'P0002'; end if;
  return json_build_object('ok', true);
end $$;

-- ───────── 呼べる人を絞る ─────────
-- Supabase は新しい関数を誰でも呼べる状態で作るので、全部いったん取り上げてから必要なものだけ渡す。

revoke all on function public.hatsu_can_view_photo(text), public.hatsu_can_upload(text), public.hatsu_can_remove(text),
  public.ping(), public.me(), public.update_profile(text, text, text), public.timeline(boolean, text, bigint),
  public.create_post(text, text, text, boolean), public.delete_post(uuid), public.set_reaction(uuid, text, boolean),
  public.report_post(uuid, text, text), public.activity(), public.activity_seen(), public.list_blocks(),
  public.set_block(uuid, boolean), public.delete_my_account(), public.admin_queue(),
  public.admin_set_status(uuid, text), public.admin_suspend(uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.ping() to anon, authenticated;
grant execute on function public.hatsu_can_view_photo(text), public.hatsu_can_upload(text), public.hatsu_can_remove(text),
  public.me(), public.update_profile(text, text, text), public.timeline(boolean, text, bigint),
  public.create_post(text, text, text, boolean), public.delete_post(uuid), public.set_reaction(uuid, text, boolean),
  public.report_post(uuid, text, text), public.activity(), public.activity_seen(), public.list_blocks(),
  public.set_block(uuid, boolean), public.delete_my_account(), public.admin_queue(),
  public.admin_set_status(uuid, text), public.admin_suspend(uuid, boolean)
  to authenticated;
