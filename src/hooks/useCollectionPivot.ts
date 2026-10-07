import { useRef, type RefObject } from "react";
import type { CollectionHistory } from "../utils/collectionNavigation";
import { collectionPivotDirection } from "../motion/collectionPivot";
import { useBrowseEntrance } from "./useBrowseEntrance";

export function useCollectionPivot(root: RefObject<HTMLElement>, history: CollectionHistory) {
  const initialRevision = useRef(history.revision);
  // The top-level page owns the first entrance; category changes own later ones.
  useBrowseEntrance(root, history.revision, history.revision === initialRevision.current ? 0 : collectionPivotDirection(history), history.animate);
}

export { useBrowsePanelMotion as useCollectionPanelMotion } from "./useBrowseEntrance";
