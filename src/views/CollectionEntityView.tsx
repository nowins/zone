import { useMemo, useRef, useState } from "react";
import { Heart, Info, ListMusic, MoreHorizontal, Play } from "lucide-react";
import { Button } from "../components/Button";
import { Cover } from "../components/Cover";
import { CollectionTrackList } from "../components/CollectionTrackList";
import { CollectionLink, useCollectionContext } from "../components/CollectionContext";
import { Dialog } from "../components/Dialog";
import { Presence, useLastNonNull } from "../motion/presence";
import { MOTION_DURATIONS } from "../motion/tokens";
import { useCollectionPanelMotion } from "../hooks/useCollectionPivot";
import { COLLECTION_ARTIST_TAB_ORDER } from "../utils/collectionNavigation";
import { albumReference, artistReference, knownDuration, resolveCollectionEntity } from "../utils/collectionEntities";
import { formatTime } from "../utils/music";
import { isSmartPlaylist, resolvePlaylistTracks } from "../utils/smartPlaylist";
import { AlbumIndex, type LibraryViewProps } from "./LibraryView";
import type { ContextPayload, Track } from "../types";

export type CollectionEntityActions = {
  onAddToQueue: (tracks: Track[]) => void;
  onInfo: (payload: ContextPayload) => void;
  onAddToPlaylist: (payload: ContextPayload) => void;
};

export function CollectionEntityView(props: LibraryViewProps & CollectionEntityActions) {
  const context = useCollectionContext()!;
  const { location } = context.navigation;
  const tabContent = useRef<HTMLDivElement>(null);
  useCollectionPanelMotion(tabContent, location.tab, COLLECTION_ARTIST_TAB_ORDER, context.navigation.history.animate);
  const value = location.entity && resolveCollectionEntity(props.index, location.entity);
  const [expandedBio, setExpandedBio] = useState(false);
  const trackId = value?.kind === "track" ? value.track.id : null;
  const containingPlaylists = useMemo(() => trackId ? props.playlists.filter(playlist =>
    resolvePlaylistTracks(playlist, props.index.tracks, { favoriteTrackIds: props.favoriteTrackIds, activity: props.trackActivity })
      .tracks.some(track => track.id === trackId)) : [], [trackId, props.playlists, props.index, props.favoriteTrackIds, props.trackActivity]);
  const bio = value?.kind === "artist" ? value.artist.biography : value?.kind === "album" ? value.album.biography : null;
  const dialog = expandedBio && bio && (value?.kind === "artist" || value?.kind === "album") ? <Dialog titleId="artist-biography-title"
    title={value.kind === "artist" ? value.artist.artist : value.album.album} kicker={value.kind === "album" ? "专辑简介" : "艺术家简介"} className="biography-dialog"
    onCancel={() => setExpandedBio(false)} onSubmit={event => event.preventDefault()}
    actions={<Button onClick={() => setExpandedBio(false)}>关闭</Button>}>
    <p className="collection-biography-full">{bio}</p>
  </Dialog> : null;
  const lastDialog = useLastNonNull(dialog);
  if (!value || value.kind === "playlist") return <div className="collection-unavailable">
    <h1 data-collection-heading tabIndex={-1}>此内容已不在曲库中</h1>
    <Button onClick={() => context.navigation.openIndex(location.view)}>返回收藏</Button>
  </div>;

  const category = value.kind === "artist" ? "artists" : value.kind === "album" ? "albums" : "songs";
  const typeLabel = value.kind === "artist" ? "艺术家" : value.kind === "album" ? "专辑" : "歌曲";
  const title = value.kind === "artist" ? value.artist.artist : value.kind === "album" ? value.album.album : value.track.title;
  const tracks = value.kind === "artist" ? value.artist.tracks : value.kind === "album" ? value.album.tracks : [value.track];
  const payload: ContextPayload = { kind: value.kind, title, subtitle: typeLabel, tracks,
    targetId: value.kind === "artist" ? value.artist.artist : value.kind === "album" ? value.album.key : value.track.id };
  const artist = value.kind === "artist" ? value.artist : props.index.artistsByName.get(value.kind === "album" ? value.album.artist : value.track.artist);
  const album = value.kind === "album" ? value.album : value.kind === "track" ? props.index.albumByTrackId.get(value.track.id) : undefined;
  const duration = knownDuration(tracks);
  const years = new Set(tracks.flatMap(track => track.year && track.year > 0 ? [track.year] : []));
  const genres = [...new Set(tracks.flatMap(track => track.genres || []))];
  const otherAlbums = artist?.albums.filter(item => item.key !== album?.key) || [];
  const relatedTracks = value.kind === "track" ? album?.tracks.filter(track => track.id !== value.track.id) || [] : [];
  const trackList = (items: Track[], key: string, compact = false, source = items) => <CollectionTrackList
    key={key} listKey={key} label={title} tracks={items} playbackTracks={source} compact={compact} scrollable={false}
    activeTrackId={props.activeTrackId} onPlay={props.onPlay} favoriteTrackIds={props.favoriteTrackIds} onToggleFavorite={props.onToggleFavorite}
    onContextMenu={(event, track) => props.onContextMenu(event, { kind: "track", title: track.title, subtitle: track.artist,
      tracks: [track], playbackTracks: source })} />;
  const artistAlbums = (items: typeof props.index.albums) => <AlbumIndex albums={items} {...props} />;

  return <>
    <div className="collection-entity-scroll" data-collection-scroll="entity">
      <header className={`collection-entity-heading${value.kind === "artist" ? " is-artist" : ""}${bio ? " has-bio" : ""}`}>
        {(value.kind !== "artist" || artist?.imagePath) && <div className="collection-entity-art" aria-hidden="true">
          <Cover artPath={value.kind === "artist" ? artist?.imagePath : album?.coverPath || tracks[0].cover_path} label={title} />
        </div>}
        <div className="collection-entity-copy">
          <button className="collection-category-link" data-collection-focus="entity-category" onClick={() => context.navigation.openIndex(category)}>{typeLabel}</button>
          <h1 data-collection-heading tabIndex={-1}>{title}</h1>
          {value.kind === "artist" ? <p className="collection-entity-meta">本地 {value.artist.albums.length} 张专辑 · {tracks.length} 首歌曲</p>
            : artist && <p className="collection-entity-artist"><CollectionLink entity={artistReference(artist)}>{artist.artist}</CollectionLink></p>}
          {value.kind === "album" && <p className="collection-entity-meta">{years.size === 1 ? `${[...years][0]} · ` : ""}
            本地 {tracks.length} 首歌曲{duration !== null ? ` · ${formatTime(duration)}` : ""}{genres.length ? ` · ${genres.join(" / ")}` : ""}</p>}
          {value.kind === "track" && <p className="collection-entity-meta">{duration !== null ? `${formatTime(duration)} · ` : ""}{value.track.extension.toUpperCase()}</p>}
          <div className="collection-entity-actions">
            <Button size="sm" icon={<Play size={14} fill="currentColor" />} disabled={!tracks.length} onClick={() => props.onPlayTracks(tracks)}>{value.kind === "track" ? "播放" : "播放本地歌曲"}</Button>
            {value.kind === "track" ? <>
              <Button size="sm" variant="ghost" className={`collection-like${props.favoriteTrackIds.has(value.track.id) ? " active" : ""}`} icon={<Heart size={15} fill={props.favoriteTrackIds.has(value.track.id) ? "currentColor" : "none"} />}
                aria-pressed={props.favoriteTrackIds.has(value.track.id)} onClick={() => props.onToggleFavorite(value.track)}>{props.favoriteTrackIds.has(value.track.id) ? "已喜欢" : "喜欢"}</Button>
              <Button size="sm" variant="ghost" onClick={() => props.onAddToPlaylist(payload)}>加入播放列表</Button>
              <Button size="sm" variant="ghost" icon={<Info size={14} />} onClick={() => props.onInfo(payload)}>文件与资料</Button>
            </> : <Button size="sm" variant="ghost" icon={<ListMusic size={15} />} onClick={() => props.onAddToQueue(tracks)}>加入队列</Button>}
            <Button size="sm" variant="ghost" icon={<MoreHorizontal size={18} />} aria-label={`${title}的更多操作`}
              onClick={event => props.onContextMenu(event, payload)}>更多</Button>
          </div>
        </div>
        {bio && <aside className="collection-artist-biography">
          <span className="collection-artist-biography-kicker">简介</span>
          <p>{bio}</p>
          <button onClick={() => setExpandedBio(true)}>展开简介</button>
        </aside>}
      </header>

      {value.kind === "artist" && <>
        <nav className="collection-detail-tabs" aria-label="艺术家内容">{COLLECTION_ARTIST_TAB_ORDER.map(tab =>
          <button key={tab} className={location.tab === tab ? "selected" : ""} aria-current={location.tab === tab ? "page" : undefined}
            data-collection-focus={`artist-tab:${tab}`} onClick={event => context.navigation.patch({ tab }, event.detail > 0)}>{{ overview: "概览", albums: "专辑", songs: "歌曲" }[tab]}</button>)}</nav>
        <div ref={tabContent} className={`collection-detail-content${location.tab === "overview" ? " collection-artist-overview" : ""}`}>
          {location.tab !== "songs" && <div>
            {value.artist.albums.length > 0 && <section className="collection-entity-section"><h2>本地专辑 <small>{value.artist.albums.length}</small></h2>
              {artistAlbums(location.tab === "overview" ? value.artist.albums.slice(0, 6) : value.artist.albums)}
              {location.tab === "overview" && value.artist.albums.length > 6 && <Button variant="ghost" size="sm" onClick={event => context.navigation.patch({ tab: "albums" }, event.detail > 0)}>查看全部专辑</Button>}
            </section>}
            {value.artist.appearances.length > 0 && <section className="collection-entity-section"><h2>参与的专辑 <small>{value.artist.appearances.length}</small></h2>
              {artistAlbums(location.tab === "overview" ? value.artist.appearances.slice(0, 6) : value.artist.appearances)}
              {location.tab === "overview" && value.artist.appearances.length > 6 && <Button variant="ghost" size="sm" onClick={event => context.navigation.patch({ tab: "albums" }, event.detail > 0)}>查看全部参与专辑</Button>}
            </section>}
          </div>}
          {location.tab !== "albums" && <section className="collection-entity-section"><h2>本地歌曲 <small>{tracks.length}</small></h2>
            {trackList(location.tab === "overview" ? tracks.slice(0, 6) : tracks, `artist:${artist!.artist}:${location.tab}`, location.tab === "overview", tracks)}
            {location.tab === "overview" && tracks.length > 6 && <Button variant="ghost" size="sm" onClick={event => context.navigation.patch({ tab: "songs" }, event.detail > 0)}>查看全部歌曲</Button>}
          </section>}
        </div>
      </>}
      {value.kind === "album" && <>
        <section className="collection-entity-section"><h2>曲目</h2>
          {new Set(tracks.map(track => track.disc_number || 1)).size > 1
            ? [...new Set(tracks.map(track => track.disc_number || 1))].map(disc => <div key={disc}><h3 className="collection-disc-label">第 {disc} 碟</h3>
              {trackList(tracks.filter(track => (track.disc_number || 1) === disc), `album:${value.album.key}:disc:${disc}`, false, tracks)}</div>)
            : trackList(tracks, `album:${value.album.key}`)}
        </section>
        {otherAlbums.length > 0 && <section className="collection-entity-section"><h2>{artist?.artist}的其他本地专辑</h2>{artistAlbums(otherAlbums)}</section>}
      </>}
      {value.kind === "track" && <>
        <div className="collection-track-relations">
          {album && <section className="collection-entity-section"><h2>所属专辑</h2><div className="collection-related-album">
            <div className="collection-related-art"><Cover artPath={album.coverPath} label={album.album} /></div>
            <div><CollectionLink entity={albumReference(album)}>{album.album}</CollectionLink><p>{album.tracks.length} 首本地歌曲</p></div>
          </div></section>}
          {containingPlaylists.length > 0 && <section className="collection-entity-section"><h2>收录于</h2><ul className="collection-playlist-relations">
            {containingPlaylists.map(playlist => <li key={playlist.id}><CollectionLink entity={{ kind: "playlist", id: playlist.id }}>{playlist.name}</CollectionLink>
              <small>{isSmartPlaylist(playlist) ? "智能播放列表" : "播放列表"}</small></li>)}
          </ul></section>}
        </div>
        {relatedTracks.length > 0 && <section className="collection-entity-section"><h2>同专辑的其他本地歌曲</h2>{trackList(relatedTracks, `related:${value.track.id}`, false, album!.tracks)}</section>}
      </>}
    </div>
    <Presence show={Boolean(dialog)} exitDurationMs={MOTION_DURATIONS.micro}>{dialog || lastDialog || <span />}</Presence>
  </>;
}
