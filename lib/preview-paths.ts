/**
 * Map files next to a nested HTML entry to paths relative to that entry's
 * directory. These aliases let root-relative template URLs resolve inside the
 * preview without changing the template source.
 *
 * A `public/` directory gets a second alias without that prefix: Vite and CRA
 * serve its contents from the site root, so templates written for them link to
 * `/img1.jpg` for a file stored at `public/img1.jpg`.
 */
export function previewRootAliases(names: string[], entryPath: string): Array<[string, string]> {
  const slash = entryPath.lastIndexOf('/');
  const root = slash < 0 ? '' : entryPath.slice(0, slash + 1);
  const aliases = new Map<string, string>();

  if (root) {
    for (const name of names) {
      if (name.startsWith(root) && name.length > root.length) aliases.set(name.slice(root.length), name);
    }
  }

  // Second pass, so a file that really sits beside the entry keeps the alias.
  const publicRoot = `${root}public/`;
  for (const name of names) {
    if (!name.startsWith(publicRoot) || name.length <= publicRoot.length) continue;
    const alias = name.slice(publicRoot.length);
    if (!aliases.has(alias)) aliases.set(alias, name);
  }

  return [...aliases];
}
