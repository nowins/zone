import { memo, type MouseEvent } from "react";
import { useEvent } from "../../../hooks/useEvent";
import type { PodcastEpisode } from "../../../types";
import { Button } from "../../../components/Button";
import { RefreshCw } from "lucide-react";
import { plainText } from "../format";
import { MetroLoader } from "../../../components/MetroLoader";
import { EpisodeRow } from "../components/EpisodeRows";
import {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
} from "../components/primitives";
import type { PodcastViewModel } from "../usePodcastViewModel";

export function ShowScreen({ vm }: { vm: PodcastViewModel }) {
  const { selectedFeed, refreshSelectedFeed, openingId, displayedEpisodes, episodeState, episodes,
    currentEpisodeId, isPlaying, downloadingId, hasMoreEpisodes, loadingEpisodePage, loadMoreEpisodes } = vm;
  const open = useEvent((episode: PodcastEpisode) => vm.openEpisodeDetail(episode, "show"));
  const play = useEvent((episode: PodcastEpisode) => vm.playEpisode(episode));
  const download = useEvent((episode: PodcastEpisode) => { void vm.downloadEpisode(episode); });
  const menu = useEvent((event: MouseEvent<HTMLElement>, episode: PodcastEpisode) => vm.showEpisodeMenu(event, episode));
  if (!selectedFeed) return null;

  return (
    <main className="podcast-screen podcast-show-screen">
              <section className="podcast-show-hero">
                <PodcastArtwork
                  url={selectedFeed.artworkUrl}
                  title={selectedFeed.title}
                  large
                />
                <div>
                  <span>{selectedFeed.subscribed ? "已加入资料库" : "公开播客"}</span>
                  <h2>{selectedFeed.title}</h2>
                  <strong>{selectedFeed.author || "未知作者"}</strong>
                  {selectedFeed.description
                    ? <p>{plainText(selectedFeed.description)}</p>
                    : null}
                </div>
                <button
                  type="button"
                  className="podcast-refresh"
                  onClick={() => void refreshSelectedFeed()}
                  disabled={Boolean(openingId)}
                  title="刷新节目"
                >
                  {openingId === selectedFeed.id
                    ? <MetroLoader size={16} />
                    : <RefreshCw size={16} />}
                  刷新
                </button>
              </section>

              <section className="podcast-show-episodes">
                <div className="podcast-section-title">
                  <h2>单集</h2>
                  <span>已加载 {displayedEpisodes.length} 集</span>
                </div>
                {episodeState === "loading" && episodes.length === 0 ? (
                  <PodcastLoading label="正在读取单集" />
                ) : displayedEpisodes.length > 0 ? (
                  displayedEpisodes.map((episode) => (
                    <ShowEpisodeRow
                      key={episode.id}
                      episode={episode}
                      active={currentEpisodeId === episode.id}
                      isPlaying={currentEpisodeId === episode.id && isPlaying}
                      downloading={downloadingId === episode.id}
                      onOpen={open}
                      onPlay={play}
                      onDownload={download}
                      onMenu={menu}
                    />
                  ))
                ) : (
                  <PodcastEmpty label="这个节目还没有可播放的单集" />
                )}
                {hasMoreEpisodes && episodeState === "ready" && (
                  <Button variant="ghost" busy={loadingEpisodePage} onClick={() => void loadMoreEpisodes()}>加载更多单集</Button>
                )}
              </section>
            </main>
  );
}

const ShowEpisodeRow = memo(function ShowEpisodeRow({ episode, active, isPlaying, downloading, onOpen, onPlay, onDownload, onMenu }: {
  episode: PodcastEpisode; active: boolean; isPlaying: boolean; downloading: boolean;
  onOpen: (episode: PodcastEpisode) => void; onPlay: (episode: PodcastEpisode) => void;
  onDownload: (episode: PodcastEpisode) => void; onMenu: (event: MouseEvent<HTMLElement>, episode: PodcastEpisode) => void;
}) {
  return <EpisodeRow episode={episode} active={active} isPlaying={isPlaying} downloading={downloading}
    onOpen={() => onOpen(episode)} onPlay={() => onPlay(episode)} onDownload={() => onDownload(episode)}
    onContextMenu={event => onMenu(event, episode)} />;
});
