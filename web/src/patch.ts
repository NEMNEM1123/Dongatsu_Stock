import { LATEST_PATCH_ID } from "../../shared/patchnotes";

const SEEN_KEY = "dg.patchSeen";

/** 아직 안 읽은 새 패치노트가 있는가 */
export const patchUnseen = (): boolean => localStorage.getItem(SEEN_KEY) !== LATEST_PATCH_ID;

export const markPatchSeen = (): void => localStorage.setItem(SEEN_KEY, LATEST_PATCH_ID);
