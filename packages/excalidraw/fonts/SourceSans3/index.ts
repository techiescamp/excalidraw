import { GOOGLE_FONTS_RANGES } from "@excalidraw/common";

import { type ExcalidrawFontFaceDescriptor } from "../Fonts";

import CyrilicExt from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EH9CsYm4fA1Tvwvw.woff2";
import Cyrilic from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EO9CsYm4fA1Tvwvw.woff2";
import GreekExt from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EG9CsYm4fA1Tvwvw.woff2";
import Greek from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EJ9CsYm4fA1Tvwvw.woff2";
import Vietnamese from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EF9CsYm4fA1Tvwvw.woff2";
import LatinExt from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EE9CsYm4fA1Tvwvw.woff2";
import Latin from "./SourceSans3-Regular-nwpBtKy2OAdR1K-IwhWudF-R9QMylBJAV3Bo8Ky462EK9CsYm4fA1Ts.woff2";

export const SourceSans3FontFaces: ExcalidrawFontFaceDescriptor[] = [
  {
    uri: CyrilicExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC_EXT },
  },
  {
    uri: Cyrilic,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.CYRILIC },
  },
  {
    uri: GreekExt,
    descriptors: { unicodeRange: GOOGLE_FONTS_RANGES.GREEK_EXT },
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
