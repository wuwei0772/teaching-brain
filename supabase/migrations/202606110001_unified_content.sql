create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'editor', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  content_type text not null,
  title text not null,
  status text not null default 'published',
  content jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references auth.users(id),
  updated_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_items_workspace_type_idx
  on public.content_items (workspace_id, content_type, created_at desc);
create index if not exists content_items_content_gin_idx
  on public.content_items using gin (content);

create table if not exists public.content_versions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content_items(id) on delete cascade,
  version_number integer not null,
  title text not null,
  status text not null,
  content jsonb not null,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  unique (content_id, version_number)
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.content_items(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_workspace(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
      and role in ('owner', 'editor')
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
begin
  insert into public.workspaces (name, owner_id)
  values (coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1), '我的') || ' 的教学大脑', new.id)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_teaching_brain on auth.users;
create trigger on_auth_user_created_teaching_brain
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.set_content_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

drop trigger if exists set_content_items_updated_at on public.content_items;
create trigger set_content_items_updated_at
  before update on public.content_items
  for each row execute procedure public.set_content_updated_at();

create or replace function public.snapshot_content_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  next_version integer;
begin
  if tg_op = 'UPDATE' and
     old.title = new.title and old.status = new.status and old.content = new.content then
    return new;
  end if;

  select coalesce(max(version_number), 0) + 1
    into next_version
    from public.content_versions
    where content_id = new.id;

  insert into public.content_versions (
    content_id, version_number, title, status, content, created_by
  ) values (
    new.id, next_version, new.title, new.status, new.content, auth.uid()
  );
  return new;
end;
$$;

drop trigger if exists snapshot_content_item_version on public.content_items;
create trigger snapshot_content_item_version
  after insert or update on public.content_items
  for each row execute procedure public.snapshot_content_version();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.content_items enable row level security;
alter table public.content_versions enable row level security;
alter table public.attachments enable row level security;

revoke all on public.workspaces from anon;
revoke all on public.workspace_members from anon;
revoke all on public.content_items from anon;
revoke all on public.content_versions from anon;
revoke all on public.attachments from anon;

grant select, update on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.content_items to authenticated;
grant select on public.content_versions to authenticated;
grant select, insert, update, delete on public.attachments to authenticated;

revoke all on function public.handle_new_user() from public;
revoke all on function public.set_content_updated_at() from public;
revoke all on function public.snapshot_content_version() from public;
revoke all on function public.is_workspace_member(uuid) from anon;
revoke all on function public.can_edit_workspace(uuid) from anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.can_edit_workspace(uuid) to authenticated;

drop policy if exists "members read workspaces" on public.workspaces;
create policy "members read workspaces" on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));

drop policy if exists "owners update workspaces" on public.workspaces;
create policy "owners update workspaces" on public.workspaces
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "members read memberships" on public.workspace_members;
create policy "members read memberships" on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "owners manage memberships" on public.workspace_members;
create policy "owners manage memberships" on public.workspace_members
  for all to authenticated
  using (
    exists (
      select 1 from public.workspaces
      where id = workspace_id and owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workspaces
      where id = workspace_id and owner_id = auth.uid()
    )
  );

drop policy if exists "members read content" on public.content_items;
create policy "members read content" on public.content_items
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "editors insert content" on public.content_items;
create policy "editors insert content" on public.content_items
  for insert to authenticated
  with check (
    public.can_edit_workspace(workspace_id)
    and created_by = auth.uid()
    and updated_by = auth.uid()
  );

drop policy if exists "editors update content" on public.content_items;
create policy "editors update content" on public.content_items
  for update to authenticated
  using (public.can_edit_workspace(workspace_id))
  with check (public.can_edit_workspace(workspace_id));

drop policy if exists "editors delete content" on public.content_items;
create policy "editors delete content" on public.content_items
  for delete to authenticated
  using (public.can_edit_workspace(workspace_id));

drop policy if exists "members read versions" on public.content_versions;
create policy "members read versions" on public.content_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.content_items item
      where item.id = content_id
        and public.is_workspace_member(item.workspace_id)
    )
  );

drop policy if exists "members read attachments" on public.attachments;
create policy "members read attachments" on public.attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.content_items item
      where item.id = content_id
        and public.is_workspace_member(item.workspace_id)
    )
  );

drop policy if exists "editors manage attachments" on public.attachments;
create policy "editors manage attachments" on public.attachments
  for all to authenticated
  using (
    exists (
      select 1 from public.content_items item
      where item.id = content_id
        and public.can_edit_workspace(item.workspace_id)
    )
  )
  with check (
    exists (
      select 1 from public.content_items item
      where item.id = content_id
        and public.can_edit_workspace(item.workspace_id)
    )
  );

insert into storage.buckets (id, name, public)
values ('teaching-brain-files', 'teaching-brain-files', false)
on conflict (id) do update set public = false;

drop policy if exists "members read teaching brain files" on storage.objects;
create policy "members read teaching brain files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'teaching-brain-files'
    and public.is_workspace_member((storage.foldername(name))[1]::uuid)
  );

drop policy if exists "editors upload teaching brain files" on storage.objects;
create policy "editors upload teaching brain files" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'teaching-brain-files'
    and public.can_edit_workspace((storage.foldername(name))[1]::uuid)
  );

drop policy if exists "editors update teaching brain files" on storage.objects;
create policy "editors update teaching brain files" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'teaching-brain-files'
    and public.can_edit_workspace((storage.foldername(name))[1]::uuid)
  );

drop policy if exists "editors delete teaching brain files" on storage.objects;
create policy "editors delete teaching brain files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'teaching-brain-files'
    and public.can_edit_workspace((storage.foldername(name))[1]::uuid)
  );

do $$
begin
  alter publication supabase_realtime add table public.content_items;
exception
  when duplicate_object then null;
end $$;

-- Backfill a personal workspace for users who existed before this migration.
do $$
declare
  existing_user record;
  new_workspace_id uuid;
begin
  for existing_user in
    select u.id, u.email
    from auth.users u
    where not exists (
      select 1 from public.workspace_members m where m.user_id = u.id
    )
  loop
    insert into public.workspaces (name, owner_id)
    values (coalesce(split_part(existing_user.email, '@', 1), '我的') || ' 的教学大脑', existing_user.id)
    returning id into new_workspace_id;

    insert into public.workspace_members (workspace_id, user_id, role)
    values (new_workspace_id, existing_user.id, 'owner');
  end loop;
end $$;
