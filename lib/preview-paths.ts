/**
 * Map files next to a nested HTML entry to paths relative to that entry's
 * directory. These aliases let root-relative template URLs resolve inside the
 * preview without changing the template source.
 */
export function previewRootAliases(names: string[], entryPath: string): Array<[string, string]> {
  const slash = entryPath.lastIndexOf('/');
  if (slash < 0) return [];

  const root = entryPath.slice(0, slash + 1);
  return names
    .filter((name) => name.startsWith(root) && name.length > root.length)
    .map((name) => [name.slice(root.length), name]);
}
