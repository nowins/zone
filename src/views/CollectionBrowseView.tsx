import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Info } from "lucide-react";
import { Button } from "../components/Button";
import { CollectionAlbumTile } from "../components/CollectionAlbumTile";
import { CollectionTrackList } from "../components/CollectionTrackList";
import { useCollectionContext } from "../components/CollectionContext";
import { albumReference, artistReference } from "../utils/collectionEntities";
import { buildCollectionGenres, initialCollectionBrowser, resolveCollectionBrowser,
  type CollectionBrowserState, type CollectionBrowseView } from "../utils/collectionBrowser";
import type { LibraryViewProps } from "./LibraryView";
import type { AlbumGroup } from "../types";

function moveChoice(event: KeyboardEvent<HTMLButtonElement>, select: (button: HTMLButtonElement) => void) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const area = event.currentTarget.closest<HTMLElement>("[data-browse-roving]");
  const buttons = [...(area?.querySelectorAll<HTMLButtonElement>("[data-browse-choice]") || [])];
  const index = buttons.indexOf(event.currentTarget);
  const grid = event.currentTarget.closest<HTMLElement>(".collection-album-index");
  const columns = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length) : 1;
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : event.key === "ArrowDown" ? index + columns : event.key === "ArrowUp" ? index - columns
      : grid && event.key === "ArrowRight" ? index + 1 : grid && event.key === "ArrowLeft" ? index - 1 : null;
  if (next === null) return;
  event.preventDefault();
  const button = buttons[Math.max(0, Math.min(next, buttons.length - 1))];
  if (!button) return;
  select(button);
  button.focus({ preventScroll: true });
  button.scrollIntoView({ block: "nearest" });
}

/** Browsing selection stays in the collection session, entirely apart from transport. */
export function CollectionBrowseView(props: LibraryViewProps & { view: CollectionBrowseView }) {
  const context = useCollectionContext();
  const [fallback, setFallback] = useState(initialCollectionBrowser);
  const browser = context?.navigation.location.browser || fallback;
  const update = (next: CollectionBrowserState) => context ? context.navigation.patch({ browser: next }, false) : setFallback(next);
  const genres = useMemo(() => buildCollectionGenres(props.index.tracks), [props.index]);
  const scope = useMemo(() => resolveCollectionBrowser(props.index, props.view, browser, genres), [props.index, props.view, browser, genres]);
  const albumScroll = useRef<HTMLDivElement>(null);
  const primaryKey = props.view === "artists" ? scope.artist?.artist || browser.artist?.name
    : props.view === "genres" ? browser.genre : "albums";
  const previousPrimary = useRef(primaryKey);
  useLayoutEffect(() => {
    if (previousPrimary.current !== primaryKey && albumScroll.current) albumScroll.current.scrollTop = 0;
    previousPrimary.current = primaryKey;
  }, [primaryKey]);

  const selectAlbum = (album: AlbumGroup | null) => update({ ...browser,
    albums: { ...browser.albums, [props.view]: album ? albumReference(album) : null } });
  const selectedAlbumKey = scope.album?.key;
  const firstAlbumKey = props.view === "genres" ? scope.albumGroups[0]?.albums[0]?.key : scope.albums[0]?.key;
  function albumTiles(albums: AlbumGroup[]) {
    return <div className="collection-album-index">
      {albums.map((album, index) => <div key={album.key} data-collection-anchor={"album:" + album.key}>
        <CollectionAlbumTile name={album.album} artist={album.artist} coverPath={album.coverPath} index={index}
          selected={album.key === selectedAlbumKey} onSelect={() => selectAlbum(album)}
          tabIndex={album.key === (selectedAlbumKey || firstAlbumKey) ? 0 : -1}
          choiceKey={album.key} onKeyDown={event => moveChoice(event, button => {
            const target = scope.albums.find(item => item.key === button.dataset.browseChoice);
            if (target) selectAlbum(target);
          })}
          focusKey={"browse-album:" + props.view + ":" + album.key}
          onDetails={() => props.onOpen(albumReference(album))}
          onPlay={() => props.onPlayTracks(albumPlayback(album))}
          onContextMenu={event => props.onContextMenu(event, { kind: "album", title: album.album,
            subtitle: album.artist, tracks: album.tracks, targetId: album.key })} />
      </div>)}
    </div>;
  }
  // The visible album may differ from the last selected album; playback always uses this album's scope.
  const albumPlayback = (album: AlbumGroup) => props.view === "genres" && scope.genre
    ? album.tracks.filter(track => scope.genre!.tracks.some(item => item.id === track.id)) : album.tracks;
  const tracksKey = "browse:" + props.view + ":" + (primaryKey || "all") + ":" + (scope.album?.key || (scope.albumMissing ? "missing" : "all"));
  const picker = props.view === "artists" ? props.index.artists : genres;
  return <div className={"collection-browse collection-browse-" + props.view}>
    {props.view !== "albums" && <section className="collection-browse-pane collection-browse-picker" aria-label={props.view === "artists" ? "艺术家索引" : "流派索引"}>
      <div className="collection-browse-caption">
        <h2>{picker.length}{props.view === "artists" ? " 位艺术家" : " 个流派"}</h2>
        <Button variant="ghost" size="sm" className="collection-browse-reset" disabled={props.view === "artists" ? !browser.artist : !browser.genre}
          aria-label={props.view === "artists" ? "全部艺术家" : "全部流派"} onClick={() => update({ ...browser,
            ...(props.view === "artists" ? { artist: null } : { genre: null }), albums: { ...browser.albums, [props.view]: null } })}>全部</Button>
      </div>
      <div className="collection-browse-scroll" data-collection-scroll={"browse-index:" + props.view}>
        <ul className="collection-browse-index" data-browse-roving>
          {props.view === "artists" ? props.index.artists.map((artist, index) => {
            const selected = scope.artist?.artist === artist.artist;
            const choose = () => update({ ...browser, artist: artistReference(artist), albums: { ...browser.albums, artists: null } });
            const tabbable = scope.artist ? selected : index === 0;
            return <li key={artist.artist} data-collection-anchor={"artist:" + artist.artist} className={selected ? "selected" : ""}>
              <Button variant="ghost" className="collection-browse-choice" data-touch-menu data-browse-choice={artist.artist}
                data-collection-focus={"browse-artist:" + artist.artist} title={artist.artist} aria-pressed={selected} tabIndex={tabbable ? 0 : -1}
                onClick={choose} onKeyDown={event => moveChoice(event, button => {
                  const target = props.index.artistsByName.get(button.dataset.browseChoice || "");
                  if (target) update({ ...browser, artist: artistReference(target), albums: { ...browser.albums, artists: null } });
                })}
                onContextMenu={event => props.onContextMenu(event, { kind: "artist", title: artist.artist, subtitle: "艺术家",
                  tracks: artist.tracks, targetId: artist.artist })}>{artist.artist}</Button>
              <Button variant="ghost" size="sm" className="collection-browse-info" aria-label={"查看艺术家 " + artist.artist}
                data-collection-focus={"browse-artist-info:" + artist.artist} tabIndex={tabbable ? 0 : -1}
                onClick={() => props.onOpen(artistReference(artist))}><Info size={14} /></Button>
            </li>;
          }) : genres.map((genre, index) => <li key={genre.key} data-collection-anchor={"genre:" + genre.key} className={scope.genre?.key === genre.key ? "selected" : ""}>
            <Button variant="ghost" className="collection-browse-choice" data-browse-choice={genre.key} title={genre.name}
              data-collection-focus={"browse-genre:" + genre.key} aria-pressed={scope.genre?.key === genre.key}
              tabIndex={scope.genre ? scope.genre.key === genre.key ? 0 : -1 : index === 0 ? 0 : -1}
              onClick={() => update({ ...browser, genre: genre.key, albums: { ...browser.albums, genres: null } })}
              onKeyDown={event => moveChoice(event, button => update({ ...browser, genre: button.dataset.browseChoice || null,
                albums: { ...browser.albums, genres: null } }))}>{genre.name}</Button>
          </li>)}
        </ul>
      </div>
    </section>}
    <section className="collection-browse-pane collection-browse-records" aria-label="专辑浏览">
      <div className="collection-browse-caption"><h2>{scope.albums.length} 张专辑</h2></div>
      <div ref={albumScroll} className="collection-browse-scroll" data-browse-roving data-collection-scroll={"browse-albums:" + props.view}>
        {scope.primaryMissing ? <p className="collection-empty">所选内容已不可用</p>
          : props.view === "genres" ? scope.albumGroups.map(group => <section key={group.name} className="collection-browse-album-group">
            <h3 title={group.name}>{group.name}</h3>{albumTiles(group.albums)}
          </section>) : albumTiles(scope.albums)}
      </div>
    </section>
    <section className="collection-browse-pane collection-browse-songs" aria-label="歌曲浏览">
      <div className="collection-browse-caption">
        <h2>{scope.tracks.length} 首歌曲 <small>{scope.album ? "曲目顺序" : "A–Z"}</small></h2>
        <Button variant="ghost" size="sm" className="collection-browse-reset" aria-label="全部专辑歌曲" disabled={!browser.albums[props.view]}
          onClick={() => selectAlbum(null)}>全部</Button>
      </div>
      {scope.album && <div className="collection-browse-album-label" title={scope.album.album}>
        <span>{scope.album.album}</span>
        <Button variant="ghost" size="sm" className="collection-browse-info" aria-label={"查看专辑 " + scope.album.album}
          data-collection-focus={"browse-selected-album-info:" + props.view} onClick={() => props.onOpen(albumReference(scope.album!))}><Info size={14} /></Button>
      </div>}
      <CollectionTrackList key={tracksKey} tracks={scope.tracks} compact label="歌曲" listKey={tracksKey}
        activeTrackId={props.activeTrackId} onPlay={props.onPlay} favoriteTrackIds={props.favoriteTrackIds} onToggleFavorite={props.onToggleFavorite}
        emptyText={scope.primaryMissing || scope.albumMissing ? "所选内容已不可用" : "暂无歌曲"}
        onContextMenu={(event, track) => props.onContextMenu(event, { kind: "track", title: track.title,
          subtitle: track.artist + " / " + track.album, tracks: [track], playbackTracks: scope.tracks })} />
    </section>
  </div>;
}
