import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import CyrilicExt from "./PlaypenSans-Regular-dg43_pj1p6gXP0gzAZgm4c8XQArSU7ACQSn4IvRhin43FNuja01fT9bG.woff2";
import Cyrilic from "./PlaypenSans-Regular-dg43_pj1p6gXP0gzAZgm4c8XQArSU7ACQSn4IvRhinc3FNuja01fT9bG.woff2";
import Greek from "./PlaypenSans-Regular-dg43_pj1p6gXP0gzAZgm4c8XQArSU7ACQSn4IvRhinA3FNuja01fT9bG.woff2";
import Vietnamese from "./PlaypenSans-Regular-dg43_pj1p6gXP0gzAZgm4c8XQArSU7ACQSn4IvRhinw3FNuja01fT9bG.woff2";
import LatinExt from "./PlaypenSans-Regular-dg43_pj1p6gXP0gzAZgm4c8XQArSU7ACQSn4IvRhin03FNuja01fT9bG.woff2";
import Latin from "./PlaypenSans-Regular-dg43_pj1p6gXP0gzAZgm4c8XQArSU7ACQSn4IvRhinM3FNuja01fTw.woff2";

export const PlaypenSansFontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: CyrilicExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC_EXT },
  },
  {
    uri: Cyrilic,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC },
  },
  {
    uri: Greek,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.GREEK },
  },
  {
    uri: Vietnamese,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.VIETNAMESE },
  },
  {
    uri: LatinExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.LATIN_EXT },
  },
  {
    uri: Latin,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.LATIN },
  },
];
