// define `EXCALIDRAW_ASSET_PATH` as a SSOT
const DEFAULT_OSS_FONTS_CDN =
  "https://excalidraw.nyc3.cdn.digitaloceanspaces.com/oss/";
const OSS_FONTS_FALLBACK = "/";

/**
 * Custom vite plugin for auto-prefixing `EXCALIDRAW_ASSET_PATH` woff2 fonts in `excalidraw-app`.
 *
 * @param {string} [fontsCdn] Base URL to serve fonts from. Self-hosted deployments
 *   pass "/" (via VITE_APP_FONTS_CDN) so fonts come from the same origin instead of
 *   the upstream CDN, which does not carry locally-added font families.
 * @returns {import("vite").PluginOption}
 */
module.exports.woff2BrowserPlugin = (fontsCdn) => {
  const OSS_FONTS_CDN = fontsCdn || DEFAULT_OSS_FONTS_CDN;
  // Vite emits the Assistant faces referenced by fonts.css at the build root,
  // not under fonts/Assistant/. Upstream only hits that path on its CDN, so a
  // self-hosted build must point at where the files actually land.
  const selfHosted = Boolean(fontsCdn);
  const ASSISTANT = `${OSS_FONTS_CDN}fonts/Assistant/`;
  let isDev;

  return {
    name: "woff2BrowserPlugin",
    enforce: "pre",
    config(_, { command }) {
      isDev = command === "serve";
    },
    transform(code, id) {
      // using copy / replace as fonts defined in the `.css` don't have to be manually copied over (vite/rollup does this automatically),
      // but at the same time can't be easily prefixed with the `EXCALIDRAW_ASSET_PATH` only for the `excalidraw-app`
      if (!isDev && id.endsWith("/excalidraw/fonts/fonts.css")) {
        return `/* WARN: The following content is generated during excalidraw-app build */

      @font-face {
        font-family: "Assistant";
        src: ${selfHosted
          ? `url(${ASSISTANT}Assistant-Regular.woff2) format("woff2")`
          : `url(${ASSISTANT}Assistant-Regular.woff2) format("woff2"), url(./Assistant-Regular.woff2) format("woff2")`};
        font-weight: 400;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: ${selfHosted
          ? `url(${ASSISTANT}Assistant-Medium.woff2) format("woff2")`
          : `url(${ASSISTANT}Assistant-Medium.woff2) format("woff2"), url(./Assistant-Medium.woff2) format("woff2")`};
        font-weight: 500;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: ${selfHosted
          ? `url(${ASSISTANT}Assistant-SemiBold.woff2) format("woff2")`
          : `url(${ASSISTANT}Assistant-SemiBold.woff2) format("woff2"), url(./Assistant-SemiBold.woff2) format("woff2")`};
        font-weight: 600;
        style: normal;
        display: swap;
      }

      @font-face {
        font-family: "Assistant";
        src: ${selfHosted
          ? `url(${ASSISTANT}Assistant-Bold.woff2) format("woff2")`
          : `url(${ASSISTANT}Assistant-Bold.woff2) format("woff2"), url(./Assistant-Bold.woff2) format("woff2")`};
        font-weight: 700;
        style: normal;
        display: swap;
      }`;
      }

      if (!isDev && id.endsWith("excalidraw-app/index.html")) {
        return code.replace(
          "<!-- PLACEHOLDER:EXCALIDRAW_APP_FONTS -->",
          `<script>
        // point into our CDN in prod, fallback to root (excalidraw.com) domain in case of issues
        window.EXCALIDRAW_ASSET_PATH = [
          "${OSS_FONTS_CDN}",
          "${OSS_FONTS_FALLBACK}",
        ];
      </script>

      <!-- Preload all default fonts to avoid swap on init -->
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <!-- For Nunito only preload the latin range, which should be good enough for now -->
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="${ASSISTANT}Assistant-SemiBold.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
      <link
        rel="preload"
        href="${OSS_FONTS_CDN}fonts/ComicShanns/ComicShanns-Regular-279a7b317d12eb88de06167bd672b4b4.woff2"
        as="font"
        type="font/woff2"
        crossorigin="anonymous"
      />
    `,
        );
      }
    },
  };
};
