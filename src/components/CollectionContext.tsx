import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import type { CollectionNavigation } from "../hooks/useCollectionNavigation";
import { collectionEntityKey, resolveCollectionEntity, type CollectionEntityRef, type CollectionIndex } from "../utils/collectionEntities";
import type { ContextPayload } from "../types";

type CollectionContextValue = {
  index: CollectionIndex;
  navigation: CollectionNavigation;
  open: (entity: CollectionEntityRef) => void;
  onContextMenu: (event: MouseEvent, payload: ContextPayload) => void;
};
export const CollectionContext = createContext<CollectionContextValue | null>(null);
export const useCollectionContext = () => useContext(CollectionContext);

export function CollectionLink({ entity, children, label, focusKey }: {
  entity: CollectionEntityRef; children: ReactNode; label?: string; focusKey?: string;
}) {
  const context = useCollectionContext();
  return <a className="collection-relation" href={`#collection/${encodeURIComponent(collectionEntityKey(entity))}`}
    aria-label={label} data-collection-focus={focusKey || collectionEntityKey(entity)}
    onClick={event => { event.preventDefault(); event.stopPropagation(); context?.open(entity); }}
    onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.key === " ") { event.preventDefault(); context?.open(entity); }
    }}
    onContextMenu={event => {
      if (!context) return;
      const value = resolveCollectionEntity(context.index, entity);
      if (!value || value.kind === "playlist") return;
      const payload: ContextPayload = value.kind === "artist"
        ? { kind: "artist", title: value.artist.artist, subtitle: "艺术家", tracks: value.artist.tracks, targetId: value.artist.artist }
        : value.kind === "album" ? { kind: "album", title: value.album.album, subtitle: value.album.artist, tracks: value.album.tracks, targetId: value.album.key }
          : { kind: "track", title: value.track.title, subtitle: value.track.artist, tracks: [value.track] };
      context.onContextMenu(event, payload);
    }}>{children}</a>;
}
