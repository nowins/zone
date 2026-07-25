# Project Notes

## Product Goal

Zone is a Tauri + React local music player inspired by Microsoft Zune 4.8. The priority is a polished local music playback experience with UI/UX that feels close to Zune rather than a generic desktop player.

The app should emphasize:

- Local music playback first.
- Zune-like collection navigation: albums, artists, songs, playlists.
- A rich `now playing` page with an artist/album mosaic background, restrained controls, subtle typography, and an audio-reactive bottom glow.
- Smooth, understated motion. Avoid flashy or obviously modern effects that break the Zune reference.

## Run Policy

- Do not automatically start a dev server for this project.
- Only run `npm run dev`, `npm run tauri:dev`, or other long-running servers when the user explicitly asks.
- Safe verification commands:
  - `npm run build`
  - `cargo check` from `src-tauri`
  - `npx tauri build --no-bundle`

## Tech Stack

- Frontend: React 18, TypeScript, Vite.
- Desktop shell: Tauri 2.
- Icons: `lucide-react`.
- Rust metadata scanning:
  - `lofty` for audio tags and embedded cover art.
  - `encoding_rs` for repairing GBK mojibake in older Chinese metadata.
  - `walkdir` for library scanning.

## Code Structure

- `src/App.tsx`
  - Top-level app state.
  - Music library scanning orchestration.
  - Playback queue, active track, shuffle/repeat, progress, volume.
  - Playlist/favorites persistence.
  - Web Audio analyser setup and visualizer sampling.

- `src/views/LibraryView.tsx`
  - Switches between collection tabs: albums, artists, songs, playlists.
  - Keeps the tab-level layout thin and delegates detailed views.

- `src/views/ArtistBrowser.tsx`
  - Zune-style artist navigation.
  - Selecting an artist shows albums and songs instead of immediately playing.

- `src/views/PlaylistBrowser.tsx`
  - Displays current queue and saved playlists.
  - Supports creating playlists.

- `src/views/NowPlayingView.tsx`
  - Full-screen now playing experience.
  - Artist/album mosaic background.
  - Queue overlay, track card, favorite button, progress/transport controls.
  - Builds SVG paths for the bottom audio glow.

- `src/components/*`
  - Reusable UI pieces: cover rendering, player bar, context menu, info panel, titlebar, empty state.

- `src/utils/music.ts`
  - Album grouping helpers, track sorting, playlist defaults, formatting helpers.

- `src/utils/visualizer.ts`
  - Converts Web Audio frequency/time-domain data into visualizer samples.
  - Avoid regular sine-wave-looking output; prefer audio-driven low-frequency plumes and energy changes.

- `src/styles.css`
  - Imports split CSS files.

- `src/styles/base.css`
  - Global shell, common typography, window/app basics.

- `src/styles/collection.css`
  - Collection views: albums, artists, songs, playlists.

- `src/styles/player.css`
  - Bottom player bar outside now-playing.

- `src/styles/now-playing.css`
  - Full-screen now-playing stage, album wall, queue overlay, track card, visualizer, transport controls.

- `src/styles/animations-responsive.css`
  - Zune-style entrance animation, wall panning, tile flip, reduced-motion and responsive rules.

- `src/styles/overlays-settings.css`
  - Context menu, info panel, settings.

- `src-tauri/src/lib.rs`
  - Folder picker command.
  - Library scanning and metadata extraction.
  - Cover extraction/cache.
  - Custom `zone-audio` protocol for CORS-safe local audio playback and Web Audio analysis.

## Persistence

- App state is stored in `localStorage` under `STORAGE_KEY` from `src/constants.ts`.
- Library schema version is `LIBRARY_SCHEMA_VERSION`.
- Favorites are implemented as the default playlist with id `DEFAULT_PLAYLIST_ID`.
- Use `normalizePlaylists` when reading playlist state so older local state gets the default favorites playlist.

## Playback And Web Audio

The visualizer must use real audio analysis, not idle animation, when music is playing.

Important constraints:

- Tauri `convertFileSrc(path)` defaults to the `asset` protocol, commonly `http://asset.localhost/...`.
- In dev, the page origin is usually `http://localhost:5173`.
- Web Audio can play cross-origin media, but `createMediaElementSource` outputs zeroes unless the media response has valid CORS headers.
- The app uses a custom Tauri protocol, `zone-audio`, for audio playback:
  - `convertFileSrc(activeTrack.path, "zone-audio")`
  - `Access-Control-Allow-Origin: *`
  - byte range support via `Accept-Ranges` and `Content-Range`
  - correct audio content types
- Keep `crossOrigin="anonymous"` on the main `<audio>`.
- Do not reintroduce a second hidden analysis `<audio>` unless there is a strong reason. The intended graph is:

```text
audioRef -> MediaElementAudioSourceNode -> AnalyserNode -> GainNode -> destination
```

If the visualizer looks fake or never reacts, first check the dev console for:

```text
MediaElementAudioSource outputs zeroes due to CORS access restrictions
```

## Now Playing Visual Direction

The now-playing page should approximate Zune 4.8:

- Background:
  - Use local album/artist covers as a mosaic.
  - Prefer the current artist's albums when building the wall.
  - Apply a soft color wash derived from the current cover.
  - Slow pan/scale only. Motion should feel like breathing, not a slideshow.
  - Random tile flips should be rare and slow.

- Typography:
  - Large, partially clipped ghost text is acceptable.
  - Keep functional text readable but restrained.
  - Avoid explanatory UI copy inside the app.

- Controls:
  - Minimal line-style controls.
  - Chrome fades out after inactivity, leaving the mosaic and song info.
  - Controls should not dominate the page.

- Visualizer:
  - It should feel like a low red/orange glow or flame at the bottom, not a traditional equalizer.
  - The outer `.visualizer` background should remain transparent or extremely subtle.
  - The visible movement should come from the SVG layers:
    - `visualizer-aura`: soft outer glow.
    - `visualizer-core`: main energy body.
    - `visualizer-crest`: top bright edge.
  - Avoid regular scrolling sine waves. The motion should be driven by bass/low-mid energy and waveform envelope.

## UX Requirements Already Implemented

- `collection`, `now playing`, and `settings` navigation works.
- Album grid scrolls vertically.
- Albums can be selected to show track lists instead of immediately playing.
- Album hover play button is delayed and subtle.
- Artists tab follows a Zune-like browser: artist -> albums -> songs.
- Right-click browser menu is suppressed.
- App text is not selectable by default.
- Custom context menu supports:
  - play
  - add to now playing
  - add to favorites
  - add to custom playlists
  - view info
- Playlists can be created.
- Favorite button on now-playing toggles the active track in the favorites playlist.

## Design Guardrails

- Keep the Zune reference front and center. Prefer understated depth over modern glassy dashboards.
- Avoid card-heavy layouts for main app surfaces.
- Avoid large explanatory text blocks in the UI.
- Avoid decorative gradients/orbs unrelated to music content.
- Use actual covers and media-derived color wherever possible.
- Text must not overlap or overflow controls in a broken way.
- Preserve keyboard/mouse expectations for desktop media software.

## Verification Checklist

Before handing off meaningful changes:

- Run `npm run build`.
- Run `cargo check` in `src-tauri` if Rust/Tauri code changed.
- Run `npx tauri build --no-bundle` for protocol, Tauri config, or release-path sensitive changes.
- For visualizer changes, test through `npm run tauri:dev` when the user asks to run the app, because browser-only Vite cannot fully verify Tauri custom protocol behavior.
