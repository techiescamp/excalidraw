const paths = {
  dashboard: "M3 3h7v8H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 15h7v6H3z",
  collection:
    "M7 3h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M3 7v13a1 1 0 0 0 1 1h13",
  lock: "M6 10h12v11H6z M9 10V6a3 3 0 0 1 6 0v4 M12 14v3",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  plus: "M12 5v14 M5 12h14",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  users:
    "M9 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M3 20v-3a6 6 0 0 1 12 0v3 M16 4a3 3 0 0 1 0 6 M18 13a5 5 0 0 1 3 4v3",
  trash: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
  arrow: "M5 12h14 M14 7l5 5-5 5",
  import: "M13 4h7v16h-7 M3 12h12 M10 7l5 5-5 5",
  scene: "M5 3h9l5 5v13H5z M14 3v6h5 M8 15h8 M12 11v8",
  pin: "M8 3h8l-1 7 4 4H5l4-4z M12 14v7",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  edit: "M4 16l12-12 4 4L8 20H4z M14 6l4 4",
  copy: "M8 8h13v13H8z M16 8V3H3v13h5",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6l4 2",
  logout: "M9 3H3v18h6 M9 12h12 M17 8l4 4-4 4",
  chevron: "M8 5l7 7-7 7",
  check: "M4 12l5 5L20 6",
  close: "M5 5l14 14 M19 5L5 19",
  storage: "M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01",
  shield: "M12 2l9 4v6c0 5-9 10-9 10S3 17 3 12V6z",
  download: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  moon: "M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12",
};
export const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${
    paths[name] || paths.collection
  }"/></svg>`;
export function relativeTime(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  for (const [unit, length] of [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (seconds >= length) {
      const n = Math.floor(seconds / length);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  return "Just now";
}
