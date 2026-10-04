import type { ReactNode } from "react";
import { Podcast } from "lucide-react";
import { Cover } from "../../../components/Cover";
import { MetroLoader } from "../../../components/MetroLoader";
import { podcastArtworkSrc } from "../../../utils/podcastArtwork";

function PodcastSection({
  title,
  count,
  actionLabel,
  onAction,
  className,
  action,
  children,
}: {
  title: string;
  count?: number;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={className ? `podcast-content-section ${className}` : "podcast-content-section"}>
      <div className="podcast-section-title">
        <h2>{title}</h2>
        {typeof count === "number" && count > 0 ? <span>{count}</span> : null}
        {action}
        {actionLabel && onAction ? (
          <button type="button" onClick={onAction}>{actionLabel}</button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function PodcastArtwork({
  url,
  title,
  large = false,
}: {
  url?: string | null;
  title: string;
  large?: boolean;
}) {
  return (
    <Cover
      src={podcastArtworkSrc(url)}
      label={title}
      className={"podcast-artwork" + (large ? " large" : "")}
      fallback={<span>{title.trim().slice(0, 1) || <Podcast size={22} />}</span>}
    />
  );
}

function PodcastLoading({ label }: { label: string }) {
  return (
    <div className="podcast-inline-state podcast-loading-state" role="status">
      <MetroLoader />
      <span>{label}</span>
    </div>
  );
}

function PodcastEmpty({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="podcast-inline-state">
      <span>{label}</span>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

export {
  PodcastArtwork,
  PodcastEmpty,
  PodcastLoading,
  PodcastSection,
};
