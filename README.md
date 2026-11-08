# Turntable — a record player visualizer for Spotify

A web app that shows what you're playing on Spotify as a record spinning in a cosy listening room.
Works on your computer and on iPhone (add it to your Home Screen and it opens full-screen like an app).

## What it does
- **The TVS turntable**: a suitcase-style record player in a 3/4 view, with a speaker-grille front and a
  "TVS" (The Vinyl Shelf) badge, volume knob, 33/45/78 speed switch and hinges. The album art is the label;
  the platter speeds up and slows down like a real one, and singles spin at 45.
- **Tonearm in the album's colour**: it shifts to the dominant colour of whatever's playing.
- **Special editions**: if a coloured, splatter, marble or picture-disc pressing of the album exists, the record
  on the turntable is drawn to match (you can switch back to classic black).
- **Vinyl & where to buy** (V): lists the album's vinyl pressings, links to the Discogs marketplace and any shops
  MusicBrainz knows about, plus searches at Discogs, Amazon, Target, Walmart, Barnes & Noble, Urban Outfitters,
  Bandcamp and eBay. If no vinyl pressing exists, it tells you.
- **Draggable tonearm.** Grab the arm and drop the needle anywhere on the record to cue that spot. On an album
  you can drop it into a different song's groove. Put it back on its rest to pause; press play and it swings back.
- **Album-aware tonearm.** When you play an album, the groove gaps on the record line up with the real
  track breaks, and the needle travels across the *whole album*, dropping into each song's groove.
  A segmented album bar shows the same thing; tap a segment to jump to that song.
- **Tracklist** for the album you're listening to (a side panel; docked on wide screens). Tap any song to play it.
- **Seek bar**: drag or click anywhere to jump within the song (arrow keys work when it's focused).
- **Record wall**: your saved albums and playlists on wooden shelves, with Albums / Playlists tabs and search
  (press `/`). Tap one and it slides out of its sleeve and goes on; the one playing is marked.
- **Singles** show as a single, with just that song in the tracklist.
- **Playing from**: a line above the song title says where it's playing from, e.g. "Playing from playlist · Road Trip".
- **Now playing stand**: the album sleeve on a wooden ledge with the record peeking out.
- **Turntable finishes**: Walnut, Oat, Clay, Charcoal, Oxblood, Rose quartz, Sage, Terracotta, Moss (in Settings).
- **Vinyl crackle**: generated in the browser, plays only while the record spins (toggle with the wave button).
- **Listening room** background that picks up the colours of the current album.

### Shortcuts
Space play/pause · ← → previous/next · F full screen · L library · T tracklist · V vinyl · C crackle ·
double-click the turntable to show just the record.

Play/pause/skip/seek and choosing records need **Spotify Premium** — that's a Spotify rule.
The visualizer, tracklist and library browsing work on free accounts.

## 1. Create a Spotify app (once)
1. Go to https://developer.spotify.com/dashboard → **Create app** → tick **Web API** only.
2. Add a **Redirect URI** for each address you'll use, exactly as shown in the app's Settings, e.g.
   `http://127.0.0.1:8888/` and `https://YOURNAME.github.io/turntable/`.
3. Under **User Management**, add the email of the Spotify account you'll log in with.
4. Copy the **Client ID** into the app's Settings and click **Connect Spotify**.

If you connected an earlier version of Turntable, the Library will ask you to **Reconnect** once —
it needs two extra permissions (read saved albums and playlists).

## 2a. Run it on your computer
```bash
python3 -m http.server 8888 --bind 127.0.0.1
```
Open http://127.0.0.1:8888 (use `127.0.0.1`, not `localhost` — Spotify rejects `localhost`).

## 2b. Put it on your iPhone
Spotify only allows `https://` for anything other than your own computer, so host it — GitHub Pages is free:
1. Create a public GitHub repo (e.g. `turntable`) and upload
   `index.html`, `styles.css`, `app.js`, `manifest.json`, `icon.svg`.
2. Repo **Settings → Pages → Deploy from branch → main / root**.
3. Add `https://YOURNAME.github.io/turntable/` as a Redirect URI in the Spotify dashboard.
4. Open it in Safari on your iPhone, connect, then **Share → Add to Home Screen**.

On iPhone, the crackle is muted while the phone's silent switch is on.

## Notes
- No server or secret keys: login uses Spotify's PKCE flow in the browser; tokens stay in that browser.
- The app checks what's playing every 3 seconds and animates smoothly in between.
- Not beat-synced: Spotify no longer offers audio analysis to new apps.
- Some Spotify-made playlists (e.g. Daily Mix, Discover Weekly) may not play through apps in
  development mode — your own playlists are fine.
- Pressing info comes from [MusicBrainz](https://musicbrainz.org), a community-run music database (no key needed).
  It's looked up once per album and remembered for a week. Coverage is great for well-known records and patchy
  for very new or niche ones. Shop links are searches — stock and prices aren't checked.
- Add `?demo` to the URL to explore with a fake record collection, no Spotify needed.
