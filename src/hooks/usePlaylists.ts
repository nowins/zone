import { useEffect, useMemo, useState } from "react";
import { DEFAULT_PLAYLIST_ID, MAX_HOME_PINS } from "../constants";
import { albumKey, defaultPlaylists, normalizePlaylists, uniqueIds } from "../utils/music";
import { applyHomePinToggle, reconcileHomePins } from "../utils/homePins";
import { isSmartPlaylist } from "../utils/smartPlaylist";
import type { PlaylistDialogState } from "../components/PlaylistDialog";
import type { SmartPlaylistDraft } from "../components/SmartPlaylistDialog";
import type {
  ContextPayload,
  HomePin,
  Playlist,
  PodcastPlayback,
  SmartPlaylist,
  Track,
  ViewMode,
} from "../types";

type UsePlaylistsParams = {
  showActionNotice: (message: string) => void;
  tracks: Track[];
  restored: boolean;
  navigateCollection: (nextView: ViewMode) => void;
  setSelectedAlbumKey: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedArtistName: React.Dispatch<React.SetStateAction<string | null>>;
  setView: React.Dispatch<React.SetStateAction<ViewMode>>;
  playbackQueueIds: string[];
  activePodcastEpisode: PodcastPlayback | null;
  activeTrack: Track | null;
  setSelectedPlaylistId: React.Dispatch<React.SetStateAction<string>>;
  playlistDialog: PlaylistDialogState | null;
  setPlaylistDialog: React.Dispatch<React.SetStateAction<PlaylistDialogState | null>>;
  smartPlaylistDialog: SmartPlaylist | "create" | null;
  setSmartPlaylistDialog: React.Dispatch<React.SetStateAction<SmartPlaylist | "create" | null>>;
};

export function usePlaylists({
  showActionNotice,
  tracks,
  restored,
  navigateCollection,
  setSelectedAlbumKey,
  setSelectedArtistName,
  setView,
  playbackQueueIds,
  activePodcastEpisode,
  activeTrack,
  setSelectedPlaylistId,
  playlistDialog,
  setPlaylistDialog,
  smartPlaylistDialog,
  setSmartPlaylistDialog,
}: UsePlaylistsParams) {
  const [playlists, setPlaylists] = useState<Playlist[]>(defaultPlaylists());
  const [homePins, setHomePins] = useState<HomePin[]>([]);

  useEffect(() => {
    if (!restored) return;
    setHomePins((current) => {
      const next = reconcileHomePins(current, tracks, playlists);
      return next.length === current.length && next.every((pin, index) => pin.id === current[index]?.id)
        ? current
        : next;
    });
  }, [playlists, restored, tracks]);

  const favoriteTrackIds = useMemo<Set<string>>(() => {
    const favorites = playlists.find((playlist) => playlist.id === DEFAULT_PLAYLIST_ID);
    return new Set(favorites && !isSmartPlaylist(favorites) ? favorites.trackIds : []);
  }, [playlists]);

  function addToPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = targetTracks.map((track) => track.id);
    if (ids.length === 0) return;
    const targetPlaylist = playlists.find((playlist) => playlist.id === playlistId);
    if (!targetPlaylist || isSmartPlaylist(targetPlaylist)) return;
    const addedCount = ids.filter((id) => !targetPlaylist.trackIds.includes(id)).length;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId && !isSmartPlaylist(playlist)
          ? { ...playlist, trackIds: uniqueIds([...playlist.trackIds, ...ids]) }
          : playlist,
      ),
    );
    showActionNotice(
      addedCount > 0
        ? `已添加 ${addedCount} 首歌曲到“${targetPlaylist.name}”`
        : `所选歌曲已在“${targetPlaylist.name}”中`,
    );
  }

  function removeFromPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = new Set(targetTracks.map((track) => track.id));
    if (ids.size === 0) return;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId && !isSmartPlaylist(playlist)
          ? { ...playlist, trackIds: playlist.trackIds.filter((id) => !ids.has(id)) }
          : playlist,
      ),
    );
  }

  function toggleFavorite() {
    if (activePodcastEpisode || !activeTrack) return;
    toggleFavoriteTrack(activeTrack);
  }

  function toggleFavoriteTrack(track: Track) {
    if (favoriteTrackIds.has(track.id)) {
      removeFromPlaylist(DEFAULT_PLAYLIST_ID, [track]);
    } else {
      addToPlaylist(DEFAULT_PLAYLIST_ID, [track]);
    }
  }

  function toggleHomePin(payload: ContextPayload) {
    // Compute from the latest committed snapshot and SET the resulting array
    // (not append inside an updater): two rapid clicks before a re-render
    // produce the same next array, so a stale double-toggle can never insert
    // the same pin twice. State updaters also run later, not synchronously,
    // so the notice cannot be decided inside the updater.
    const next = applyHomePinToggle(homePins, payload);
    if (next.action === "pinned" || next.action === "unpinned") {
      setHomePins(next.pins);
    }
    if (next.action === "capped") {
      showActionNotice(`quickplay 最多固定 ${MAX_HOME_PINS} 项内容`);
      return;
    }
    if (next.action === "pinned") {
      showActionNotice(`已固定“${payload.title}”到 quickplay`);
    } else if (next.action === "unpinned") {
      showActionNotice(`已从 quickplay 取消固定“${payload.title}”`);
    }
  }

  // 磁贴/右键菜单的次级动作"在收藏中打开"：按 payload 身份定位到收藏视图。
  // 专辑优先用创建时写入的稳定 targetId，避免从展示文案反推分组键。
  function openPayloadInCollection(payload: ContextPayload) {
    if (payload.kind === "album") {
      setSelectedAlbumKey(payload.targetId ?? albumKey(payload.title, payload.subtitle));
      navigateCollection("albums");
      return;
    }
    if (payload.kind === "artist") {
      setSelectedArtistName(payload.title);
      navigateCollection("artists");
      return;
    }
    if (payload.kind === "playlist") {
      if (payload.playlistId) setSelectedPlaylistId(payload.playlistId);
      navigateCollection("playlists");
    }
  }

  function createPlaylist(name: string) {
    const cleanName = name.trim();
    if (!cleanName) return;

    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: "自定义播放列表",
      kind: "manual",
      trackIds: [],
    };

    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
    setSelectedPlaylistId(playlist.id);
    setView("playlists");
    showActionNotice(`已创建播放列表“${playlist.name}”`);
  }

  function createPlaylistWithTracks(name: string, targetTracks: Track[]) {
    const cleanName = name.trim();
    const trackIds = uniqueIds(targetTracks.map((track) => track.id));
    if (!cleanName || trackIds.length === 0) return;
    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: "自定义播放列表",
      kind: "manual",
      trackIds,
    };
    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
    showActionNotice(`已创建“${playlist.name}”并添加 ${trackIds.length} 首歌曲`);
  }

  function renamePlaylist(playlistId: string, name: string) {
    const cleanName = name.trim();
    if (!cleanName || playlistId === DEFAULT_PLAYLIST_ID) return;

    setPlaylists((items) =>
      normalizePlaylists(items).map((playlist) =>
        playlist.id === playlistId && !isSmartPlaylist(playlist) ? { ...playlist, name: cleanName } : playlist,
      ),
    );
    showActionNotice(`播放列表已重命名为“${cleanName}”`);
  }

  function deletePlaylist(playlistId: string) {
    if (playlistId === DEFAULT_PLAYLIST_ID) return;
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist) return;

    setPlaylists((items) => normalizePlaylists(items).filter((item) => item.id !== playlistId));
    setSelectedPlaylistId((current) => current === playlistId ? DEFAULT_PLAYLIST_ID : current);
    showActionNotice(`已删除播放列表“${playlist.name}”`);
  }

  function openCreatePlaylistDialog() {
    setPlaylistDialog({ mode: "create", playlistName: "" });
  }

  function openCreateSmartPlaylist() {
    setPlaylistDialog(null);
    setSmartPlaylistDialog("create");
  }

  function openSmartPlaylistEditor(playlistId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist || !isSmartPlaylist(playlist)) return;
    setPlaylistDialog(null);
    setSmartPlaylistDialog(playlist);
  }

  function saveSmartPlaylist(draft: SmartPlaylistDraft) {
    if (smartPlaylistDialog === "create") {
      const playlist: SmartPlaylist = {
        id: `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        kind: "smart",
        ...draft,
      };
      setPlaylists((items) => [...normalizePlaylists(items), playlist]);
      setSelectedPlaylistId(playlist.id);
      setView("playlists");
      showActionNotice(`已创建智能播放列表“${playlist.name}”`);
    } else if (smartPlaylistDialog) {
      setPlaylists((items) => normalizePlaylists(items).map((playlist) =>
        playlist.id === smartPlaylistDialog.id && isSmartPlaylist(playlist)
          ? { ...playlist, ...draft }
          : playlist,
      ));
      showActionNotice(`已更新智能播放列表“${draft.name}”`);
    }
    setSmartPlaylistDialog(null);
  }

  function refreshSmartPlaylist(playlistId: string) {
    setPlaylists((items) => normalizePlaylists(items).map((playlist) =>
      playlist.id === playlistId && isSmartPlaylist(playlist)
        ? { ...playlist, smart: { ...playlist.smart, rotationSeed: playlist.smart.rotationSeed + 1 } }
        : playlist,
    ));
    showActionNotice("已换一批歌曲");
  }

  function excludeFromSmartPlaylist(playlistId: string, targetTracks: Track[]) {
    const ids = targetTracks.map((track) => track.id);
    if (ids.length === 0) return;
    setPlaylists((items) => normalizePlaylists(items).map((playlist) =>
      playlist.id === playlistId && isSmartPlaylist(playlist)
        ? { ...playlist, excludedTrackIds: uniqueIds([...playlist.excludedTrackIds, ...ids]) }
        : playlist,
    ));
    showActionNotice(`已从智能列表中排除 ${ids.length} 首歌曲`);
  }

  function openPlaylistDialog(mode: "rename" | "delete", playlistId: string) {
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist || playlist.id === DEFAULT_PLAYLIST_ID) return;
    if (mode === "rename" && isSmartPlaylist(playlist)) {
      openSmartPlaylistEditor(playlistId);
      return;
    }
    setPlaylistDialog({ mode, playlistId, playlistName: playlist.name });
  }

  function submitPlaylistDialog(name: string) {
    if (!playlistDialog) return;
    if (playlistDialog.mode === "create") createPlaylist(name);
    if (playlistDialog.mode === "rename" && playlistDialog.playlistId) {
      renamePlaylist(playlistDialog.playlistId, name);
    }
    if (playlistDialog.mode === "delete" && playlistDialog.playlistId) {
      deletePlaylist(playlistDialog.playlistId);
    }
    setPlaylistDialog(null);
  }

  function saveQueueAsPlaylist(name: string) {
    const cleanName = name.trim();
    const trackIds = uniqueIds(playbackQueueIds);
    if (!cleanName || trackIds.length === 0) return;

    const playlist: Playlist = {
      id: `playlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      description: "自定义播放列表",
      kind: "manual",
      trackIds,
    };

    setPlaylists((items) => [...normalizePlaylists(items), playlist]);
  }

  return {
    playlists,
    setPlaylists,
    homePins,
    setHomePins,
    favoriteTrackIds,
    addToPlaylist,
    createPlaylistWithTracks,
    toggleFavorite,
    toggleFavoriteTrack,
    toggleHomePin,
    openPayloadInCollection,
    openCreatePlaylistDialog,
    openCreateSmartPlaylist,
    openSmartPlaylistEditor,
    saveSmartPlaylist,
    refreshSmartPlaylist,
    excludeFromSmartPlaylist,
    openPlaylistDialog,
    submitPlaylistDialog,
    saveQueueAsPlaylist,
  };
}
