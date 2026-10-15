import { NAVIGATION_MOTION, BROWSE_MOTION, MOTION_EASINGS, MOTION_DURATIONS } from "./tokens.js";
import type { PageTransition } from "./pageTransition.js";
import { readSurfaceFrame as frame, snapshotSurface, surfaceOffset, type Frame } from "./surfaceSnapshot.js";
import { browseSurface, browseContentPending, concealPendingBrowseTitles, captureBrowseFrames, playBrowseTransition, type BrowseControl, type BrowseFrames } from "./browseTransition.js";
export { snapshotSurface, surfaceOffset } from "./surfaceSnapshot.js";

type Surface = { key: string; node: HTMLElement; layer: HTMLElement; animation: Animation };
const pageSelector = ".quickplay,.content-band,.now-playing-stage";
const groupSelector = ".quick-group,.settings-main-stack,.settings-sidebar";
const easing = `cubic-bezier(${MOTION_EASINGS.navigation.join(",")})`;

/** Paired page hand-off; browsing pages delegate to the shared content controller. */
export class SurfaceTransition {
  private outgoing: Surface | null = null;
  private incoming: Animation[] = [];
  private returning: Frame[] | null = null;
  private returningBrowse: BrowseFrames | null = null;
  private sourceBrowse: BrowseFrames | null = null;
  private browsing: BrowseControl | null = null;
  private source: HTMLElement | null = null;
  private plan: PageTransition | null = null;
  private revealPending: (() => void) | null = null;

  constructor(private host: HTMLElement) {}

  private groups(node: HTMLElement): HTMLElement[] {
    return [...node.querySelectorAll<HTMLElement>(groupSelector)].filter(group => {
      const parent = group.parentElement?.closest(groupSelector);
      return !parent || !node.contains(parent);
    }).slice(0, NAVIGATION_MOTION.maxGroups);
  }

  current(): HTMLElement | null {
    return [...this.host.children].find(node => node.matches(pageSelector)) as HTMLElement | undefined ?? null;
  }

  prepare(from: string, to: string, plan: PageTransition, enabled: boolean): void {
    const page = this.current(), immersive = to === "nowPlaying";
    const content = !immersive && page ? browseSurface(page) : null;
    // Immersive layout removes browsing chrome immediately. Its frozen
    // shell departs as one image, preserving the header and transport slots.
    const source = immersive ? page?.closest<HTMLElement>(".shell") ?? page : content ?? page;
    enabled = enabled && typeof this.host.animate === "function";
    const returning = this.outgoing?.key === to
      ? [this.outgoing.node, ...this.groups(this.outgoing.node)].map(frame) : null;
    const returningBrowse = returning && this.outgoing ? captureBrowseFrames(this.outgoing.node) : null;
    const snapshot = source && enabled ? snapshotSurface(source) : null;
    const sourceBrowse = snapshot && content ? captureBrowseFrames(snapshot.node) : null;
    this.stop();
    this.returning = returning;
    this.returningBrowse = returningBrowse;
    this.sourceBrowse = sourceBrowse;
    this.source = source;
    this.plan = enabled ? plan : null;
    if (!snapshot) return;
    // Peer navigation only captures data; the immersive handoff stays in place.
    if (!immersive) snapshot.node.querySelectorAll<HTMLElement>(".playlist-list").forEach(node => { node.style.visibility = "hidden"; });
    const start = frame(snapshot.node), offset = surfaceOffset(snapshot.node);
    const animation = snapshot.node.animate([
      start,
      { transform: content || immersive ? start.transform : `translate3d(${offset.x - plan.direction * plan.exitDriftPx}px,${offset.y}px,0)`, opacity: 0 },
    ], { duration: content ? BROWSE_MOTION.exit : plan.exitMs, easing: content ? `cubic-bezier(${MOTION_EASINGS.browse.join(",")})` : easing, fill: "forwards" });
    this.outgoing = { ...snapshot, key: from, animation };
    animation.onfinish = () => {
      if (this.outgoing?.animation !== animation) return;
      snapshot.layer.remove(); this.outgoing = null; animation.cancel();
    };
  }

  enter(): boolean {
    const root = this.current(), plan = this.plan;
    if (!root) return false;
    const browser = root.matches(".collection-connected,.podcast-page,.quickplay");
    const content = browser ? browseSurface(root) : null;
    if (browser && !content) return false;
    if (content && plan && browseContentPending(content)) {
      this.revealPending ??= concealPendingBrowseTitles(content);
      return false;
    }
    this.revealPending?.(); this.revealPending = null;
    this.plan = null;
    const source = this.source;
    this.source = null;
    if (plan && content) {
      this.browsing = playBrowseTransition(content, plan.direction, content === source ? this.sourceBrowse : this.returningBrowse, () => this.clearOutgoing());
      this.returning = null; this.returningBrowse = null; this.sourceBrowse = null;
      return true;
    }
    this.returningBrowse = null; this.sourceBrowse = null;
    if (!plan || root.matches(".now-playing-stage")) { this.returning = null; return true; }
    root.querySelectorAll<HTMLElement>(".quick-group,.quick-album,.folder-list > div,.settings-section-heading,.settings-sidebar > section")
      .forEach(node => { node.style.animation = "none"; });
    const groups = this.groups(root);
    const starts = root === source ? [root, ...groups].map(frame) : this.returning;
    this.returning = null;
    const animate = (node: HTMLElement, frames: Keyframe[], duration: number, delay = 0) => {
      const animation = node.animate(frames, { duration, delay, easing, fill: "backwards" });
      this.incoming.push(animation);
      animation.onfinish = () => {
        animation.onfinish = null; animation.cancel();
        this.incoming = this.incoming.filter(item => item !== animation);
      };
    };
    animate(root, [
      { transform: starts?.[0]?.transform ?? `translate3d(${plan.direction * plan.enterDriftPx}px,0,0)` },
      { transform: "none" },
    ], plan.enterMs);
    animate(root, [{ opacity: starts?.[0]?.opacity ?? 0 }, { opacity: 1 }], NAVIGATION_MOTION.fade);
    groups.forEach((node, index) => animate(node, [
      { transform: starts?.[index + 1]?.transform ?? `translate3d(${plan.direction * NAVIGATION_MOTION.groupDrift}px,0,0)` },
      { transform: "none" },
    ], plan.enterMs, Math.min(index, 2) * NAVIGATION_MOTION.stagger));
    return true;
  }

  /** Internal navigation takes over the moving data, while chrome stays still. */
  settle(): void {
    this.browsing?.settle();
    const nodes = new Set(this.incoming.map(animation => (animation.effect as KeyframeEffect).target as HTMLElement));
    const starts = [...nodes].filter(node => this.host.contains(node)).map(node => ({ node, start: frame(node) }));
    if (!starts.length) return;
    for (const animation of this.incoming) { animation.onfinish = null; animation.cancel(); }
    this.incoming = [];
    for (const { node, start } of starts) {
      const animation = node.animate([start, { transform: "none", opacity: 1 }], { duration: MOTION_DURATIONS.press, easing, fill: "backwards" });
      this.incoming.push(animation);
      animation.onfinish = () => {
        animation.onfinish = null; animation.cancel(); this.incoming = this.incoming.filter(item => item !== animation);
      };
    }
  }

  stop(): void {
    this.revealPending?.(); this.revealPending = null;
    this.browsing?.(); this.browsing = null;
    for (const animation of this.incoming) { animation.onfinish = null; animation.cancel(); }
    this.incoming = [];
    this.clearOutgoing();
    this.plan = null; this.source = null; this.returning = null;
    this.returningBrowse = null; this.sourceBrowse = null;
  }

  private clearOutgoing(): void {
    if (!this.outgoing) return;
    this.outgoing.animation.onfinish = null; this.outgoing.animation.cancel();
    this.outgoing.layer.remove(); this.outgoing = null;
  }
}
