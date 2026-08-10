// scripts/rag/react-lib.mjs
// Making the React third of the corpus usable.
//
// 139 of 430 projects are React and 63 are Next; assemble skipped all of them,
// so 47% of the archive could never appear in a composition — which quietly
// skewed every reuse-versus-generation comparison run against it.
//
// React is tractable without a build server: esbuild bundles the local files,
// every bare import is left external and resolved in the browser by an import
// map pointing at a CDN. No `npm install` per project — which matters, because
// the ingest deliberately never captured node_modules.
//
// Next is not tractable the same way. Its pages are modules in a framework that
// owns routing, layout and (in the app router) server rendering; a `page.js` is
// not a component you can mount into a section. Those stay skipped, with that as
// the stated reason rather than a vague one.
//
// Pure — no I/O, no esbuild, unit-tested offline.

const CDN = 'https://esm.sh';

// React must resolve to ONE instance across every section on the page: two
// copies means two dispatchers and "invalid hook call" on the second mount.
const PINNED = { react: '19.2.0', 'react-dom': '19.2.0' };

/** Where a React project starts. Vite uses src/main.*, CRA uses src/index.*. */
export function pickReactEntry(files) {
  const rank = [
    /(^|\/)src\/main\.(jsx?|tsx?)$/i,
    /(^|\/)src\/index\.(jsx?|tsx?)$/i,
    /(^|\/)src\/App\.(jsx?|tsx?)$/i,
    /(^|\/)main\.(jsx?|tsx?)$/i,
    /(^|\/)index\.(jsx?|tsx?)$/i,
  ];
  for (const re of rank) {
    const hit = files.find((f) => re.test(f));
    if (hit) return hit;
  }
  return null;
}

/** A bare specifier is a dependency; anything relative is a file in the project. */
export function isBareSpecifier(spec) {
  return !!spec && !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-z]+:/i.test(spec);
}

/** `framer-motion/dist/x` -> `framer-motion`; `@gsap/react/x` -> `@gsap/react`. */
export function packageOf(spec) {
  const parts = String(spec).split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function cdnUrl(spec) {
  const pkg = packageOf(spec);
  const rest = String(spec).slice(pkg.length);
  const version = PINNED[pkg] ? `@${PINNED[pkg]}` : '';
  // Dependencies must share this page's React, not fetch their own.
  const deps = pkg === 'react' || pkg === 'react-dom' ? '' : `?external=react,react-dom`;
  return `${CDN}/${pkg}${version}${rest}${deps}`;
}

/**
 * One import map for the whole page — the browser allows exactly one, so every
 * section's dependencies are merged into it. Sorted for a stable diff.
 */
export function buildImportMap(specs) {
  const imports = {};
  for (const spec of new Set(specs.filter(isBareSpecifier))) {
    imports[spec] = cdnUrl(spec);
    const pkg = packageOf(spec);
    if (pkg !== spec) imports[pkg] = cdnUrl(pkg);        // the root, for deep imports
    if (!imports[`${pkg}/`]) imports[`${pkg}/`] = `${cdnUrl(pkg).split('?')[0]}/`;
  }
  return { imports: Object.fromEntries(Object.keys(imports).sort().map((k) => [k, imports[k]])) };
}

/**
 * Point the app at its own container.
 *
 * Every one of these projects mounts to `#root`, because each owned a document.
 * On a composed page there is one document and several React sections, so each
 * gets its own container and its bundle is retargeted at it. Left alone, the
 * second section would mount into the first's root and erase it.
 */
export function retargetMount(js, containerId) {
  return String(js ?? '')
    .replace(/document\s*\.\s*getElementById\(\s*(["'`])root\1\s*\)/g, `document.getElementById("${containerId}")`)
    .replace(/document\s*\.\s*querySelector\(\s*(["'`])#root\1\s*\)/g, `document.getElementById("${containerId}")`);
}

/** The container id for a slot — stable, and valid in a selector. */
export const rootIdFor = (slot) => `react-root-${String(slot).replace(/[^a-z0-9_-]/gi, '-')}`;
