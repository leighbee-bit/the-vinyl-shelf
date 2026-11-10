-- The Vinyl Shelf: community ratings & reviews.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

-- Public profile: the name shown on your reviews
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "Profiles are public" on public.profiles for select using (true);
create policy "Create your own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "Edit your own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- One review per person per album. rating is half-stars: 1 = ½★ … 10 = 5★
create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  album_key text not null check (char_length(album_key) between 3 and 300),   -- "artist|title", normalised
  spotify_album_id text check (char_length(spotify_album_id) <= 64),
  album_name text not null check (char_length(album_name) <= 300),
  artist text not null check (char_length(artist) <= 300),
  cover_url text check (cover_url is null or cover_url ~ '^https://'),
  rating smallint check (rating between 1 and 10),
  body text check (char_length(body) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, album_key),
  check (rating is not null or char_length(btrim(coalesce(body, ''))) > 0)
);
alter table public.reviews enable row level security;
create policy "Reviews are public" on public.reviews for select using (true);
create policy "Write your own reviews" on public.reviews for insert with check (auth.uid() = user_id);
create policy "Edit your own reviews" on public.reviews for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Delete your own reviews" on public.reviews for delete using (auth.uid() = user_id);
create index if not exists reviews_album_idx on public.reviews (album_key, created_at desc);
create index if not exists reviews_recent_idx on public.reviews (created_at desc);
