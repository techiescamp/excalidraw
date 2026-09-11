// Collaboration snapshots converge by the editor's element version/nonce rule.
// Keep tombstones and files: absent elements are not evidence of deletion.
export function mergeSceneSnapshots(current, incoming) {
  const elements = new Map(
    current.elements.map((element) => [element.id, element]),
  );
  for (const element of incoming.elements) {
    const saved = elements.get(element.id);
    if (
      !saved ||
      (element.version || 0) > (saved.version || 0) ||
      ((element.version || 0) === (saved.version || 0) &&
        (element.versionNonce ?? 0) < (saved.versionNonce ?? 0))
    )
      elements.set(element.id, element);
  }
  const ordered = [...elements.values()];
  if (ordered.every((element) => typeof element.index === "string"))
    ordered.sort((a, b) =>
      a.index < b.index ? -1 : a.index > b.index ? 1 : 0,
    );
  return {
    ...incoming,
    elements: ordered,
    files: { ...current.files, ...incoming.files },
  };
}
