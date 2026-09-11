import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import CyrilicExt from "./Manrope-Regular-xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FN_P-bnTfc7AGraJwA.woff2";
import Cyrilic from "./Manrope-Regular-xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FN_G-bnTfc7AGraJwA.woff2";
import Greek from "./Manrope-Regular-xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FN_B-bnTfc7AGraJwA.woff2";
import Vietnamese from "./Manrope-Regular-xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FN_N-bnTfc7AGraJwA.woff2";
import LatinExt from "./Manrope-Regular-xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FN_M-bnTfc7AGraJwA.woff2";
import Latin from "./Manrope-Regular-xn7_YHE41ni1AdIRqAuZuw1Bx9mbZk79FN_C-bnTfc7AGrY.woff2";

export const ManropeFontFaces: ExcalidrawFontFaceDescriptor[] = [
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
