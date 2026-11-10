-- The Vinyl Shelf: Trending page (likes on reviews + album stats).
-- Run once after schema.sql: Supabase → SQL Editor → New query → paste this file → Run.
-- Safe to run again.

-- Likes on reviews: one per person per review
create table if not exists public.review_likes (
  review_id uuid not null references public.reviews (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (review_id, user_id)
);
alter table public.review_likes enable row level security;
drop policy if exists "Likes are public" on public.review_likes;
drop policy if exists "Like as yourself" on public.review_likes;
drop policy if exists "Remove your own likes" on public.review_likes;
create policy "Likes are public" on public.review_likes for select using (true);
create policy "Like as yourself" on public.review_likes for insert with check (auth.uid() = user_id);
create policy "Remove your own likes" on public.review_likes for delete using (auth.uid() = user_id);
create index if not exists review_likes_review_idx on public.review_likes (review_id);
create index if not exists review_likes_recent_idx on public.review_likes (created_at desc);

-- One row per album: how many ratings, the average, and how many in the last 7 days.
-- security_invoker: the views read the tables with the visitor's own permissions (the public read rules above).
create or replace view public.album_stats with (security_invoker = true) as
select
  album_key,
  (array_agg(album_name order by updated_at desc))[1] as album_name,
  (array_agg(artist order by updated_at desc))[1] as artist,
  (array_agg(cover_url order by updated_at desc) filter (where cover_url is not null))[1] as cover_url,
  (array_agg(spotify_album_id order by updated_at desc) filter (where spotify_album_id is not null))[1] as spotify_album_id,
  count(rating) as ratings,
  round(avg(rating), 2) as avg_rating,
  count(rating) filter (where updated_at > now() - interval '7 days') as recent,
  max(updated_at) as last_at
from public.reviews
group by album_key;

-- Every review with its author's name and like counts (all time and last 7 days)
create or replace view public.review_popularity with (security_invoker = true) as
select
  r.id, r.user_id, r.album_key, r.album_name, r.artist, r.cover_url, r.spotify_album_id,
  r.rating, r.body, r.updated_at,
  p.display_name,
  count(l.user_id) as likes,
  count(l.user_id) filter (where l.created_at > now() - interval '7 days') as recent_likes
from public.reviews r
join public.profiles p on p.id = r.user_id
left join public.review_likes l on l.review_id = r.id
group by r.id, p.display_name;

grant select on public.album_stats, public.review_popularity to anon, authenticated;
grant select, insert, delete on public.review_likes to authenticated;
grant select on public.review_likes to anon;
