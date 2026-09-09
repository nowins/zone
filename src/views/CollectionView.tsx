import { useLayoutEffect, useRef, type RefObject } from "react";
import { ArrowLeft } from "lucide-react";
import { CollectionContext } from "../components/CollectionContext";
import { CollectionSearchField } from "../components/CollectionSearchField";
import { EmptyState } from "../components/EmptyState";
import { LibraryView, type LibraryViewProps } from "./LibraryView";
import { CollectionEntityView, type CollectionEntityActions } from "./CollectionEntityView";
import { SearchResultsView } from "./SearchResultsView";
import type { CollectionNavigation } from "../hooks/useCollectionNavigation";
import { useCollectionPivot } from "../hooks/useCollectionPivot";
import { resolveCollectionEntity, artistReference, albumReference } from "../utils/collectionEntities";
import { resolveSearchSurface } from "../utils/collectionSearch";
import { COLLECTION_CATEGORY_ORDER, type CollectionLocation } from "../utils/collectionNavigation";
import type { ViewMode } from "../types";

const labels: Record<ViewMode, string> = { artists: "艺术家", albums: "专辑", songs: "歌曲", playlists: "播放列表" };
type Props = LibraryViewProps & CollectionEntityActions & {
  navigation: CollectionNavigation;
  onTravel: (direction: 1 | -1) => void;
  searchInputRef: RefObject<HTMLInputElement>;
  onQuery: (query: string) => void;
  onClearSearch: () => void;
  onAddFolder: () => void;
  isScanning: boolean;
  scanNote: string;
};
export function CollectionView(props: Props) {
  const { navigation, index } = props;
  const { location, history } = navigation;
  const searching = resolveSearchSurface(location.query, location.searchMode) === "results";
  const detail = Boolean(location.entity) && !searching;
  const previous = history.entries[history.cursor - 1];
  const canBack = history.cursor > 0;
  function locationLabel(value: CollectionLocation | undefined) {
    if (!value) return "收藏";
    if (value.query.trim() && value.searchMode === "results") return "搜索结果";
    if (!value.entity) {
      if (value.view !== "playlists") return `${labels[value.view]}列表`;
      return value.playlistId === "now" ? "正在播放" : props.playlists.find(p => p.id === value.playlistId)?.name || "播放列表";
    }
    const resolved = resolveCollectionEntity(index, value.entity);
    return resolved?.kind === "artist" ? resolved.artist.artist : resolved?.kind === "album" ? resolved.album.album : resolved?.kind === "track" ? resolved.track.title : "收藏";
  }
  const previousLabel = location.origin ? { quickplay: "quickplay", nowPlaying: "正在播放", podcasts: "播客", settings: "设置" }[location.origin.page] : locationLabel(previous);
  useLayoutEffect(() => navigation.restore(), [history.revision, navigation.restore]);
  const contentRef = useRef<HTMLDivElement>(null);
  useCollectionPivot(contentRef, history);
  const count = props.view === "artists" ? `${index.artists.length} 位艺术家` : props.view === "albums" ? `${index.albums.length} 张专辑`
    : props.view === "songs" ? `${index.tracks.length} 首歌曲` : `${props.playlists.length + 1} 个列表`;
  return <CollectionContext.Provider value={{ index, navigation, open: props.onOpen, onContextMenu: props.onContextMenu }}>
    <section ref={navigation.rootRef} className="content-band collection-band collection-connected"
      onFocusCapture={event => navigation.recordFocus(event.target)}
      onKeyDown={event => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        if (!(event.target instanceof HTMLElement) || event.target.matches("input,textarea")) return;
        event.preventDefault();
        const rect = event.target.getBoundingClientRect();
        event.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom }));
      }}
      onAuxClick={event => {
        if (event.button !== 3 && event.button !== 4) return;
        event.preventDefault(); props.onTravel(event.button === 3 ? -1 : 1);
      }}>
      <div className="collection-toolbar">
        {detail || searching ?
          <button type="button" data-collection-focus="back" className="collection-back" disabled={!canBack}
            aria-label={`返回${previousLabel}`} title={`返回${previousLabel}`} onClick={() => props.onTravel(-1)}>
            <ArrowLeft size={18} /><span>返回{previousLabel}</span>
          </button>
        : <nav className="collection-categories" aria-label="收藏视图">
          {COLLECTION_CATEGORY_ORDER.map(view => <button key={view}
            data-collection-focus={`index:${view}`} aria-current={view === props.view ? "page" : undefined}
            className={view === props.view ? "selected" : ""} onClick={event => navigation.openIndex(view, event.detail > 0)}>{labels[view]}</button>)}
        </nav>}
        <CollectionSearchField ref={props.searchInputRef} query={location.query} onQuery={props.onQuery} onClear={props.onClearSearch}
          showReturnToResults={false} onReturnToResults={() => navigation.patch({ searchMode: "results" })} />
      </div>
      {!detail && <div className="collection-index-caption">
        <h1 className="collection-visually-hidden" data-collection-heading tabIndex={-1}>{searching ? "搜索结果" : labels[props.view]}</h1>
        {!searching && <p>{count}{props.scanNote ? ` · ${props.scanNote}` : ""}</p>}
      </div>}
      <div ref={contentRef} key={history.revision} className="collection-content">
        {searching ? <SearchResultsView query={location.query} tracks={index.tracks} albums={index.albums} artists={index.artists}
          playlists={props.playlists} activity={props.trackActivity} favoriteTrackIds={props.favoriteTrackIds}
          activeTrackId={props.activeTrackId} onPlay={props.onPlay} onToggleFavorite={props.onToggleFavorite}
          onOpenArtist={name => { const artist = index.artistsByName.get(name); if (artist) props.onOpen(artistReference(artist)); }}
          onOpenAlbum={key => { const album = index.albumByKey.get(key); if (album) props.onOpen(albumReference(album)); }}
          onOpenPlaylist={id => props.onOpen({ kind: "playlist", id })} onContextMenu={props.onContextMenu} />
          : detail ? <CollectionEntityView {...props} />
            : !index.tracks.length && props.view !== "playlists" ? <EmptyState onAddFolder={props.onAddFolder} isScanning={props.isScanning} />
              : <LibraryView {...props} />}
      </div>
    </section>
  </CollectionContext.Provider>;
}
