import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickReactEntry, isBareSpecifier, packageOf, cdnUrl, buildImportMap, retargetMount, rootIdFor,
} from './react-lib.mjs';

test('pickReactEntry prefers the real entry over the component it renders', () => {
  // Vite projects boot from src/main.jsx; App.jsx is what it renders, not the start.
  assert.equal(pickReactEntry(['src/App.jsx', 'src/main.jsx', 'src/index.css']), 'src/main.jsx');
  assert.equal(pickReactEntry(['src/App.js', 'src/index.js']), 'src/index.js');   // CRA
  assert.equal(pickReactEntry(['cg-cards/src/main.jsx']), 'cg-cards/src/main.jsx');
  assert.equal(pickReactEntry(['src/App.jsx']), 'src/App.jsx');                   // last resort
  assert.equal(pickReactEntry(['index.html', 'styles.css']), null);
});

test('isBareSpecifier separates dependencies from project files', () => {
  assert.equal(isBareSpecifier('framer-motion'), true);
  assert.equal(isBareSpecifier('@gsap/react'), true);
  assert.equal(isBareSpecifier('./App'), false);
  assert.equal(isBareSpecifier('../lib/x'), false);
  assert.equal(isBareSpecifier('/abs.js'), false);
  assert.equal(isBareSpecifier('https://cdn/x.js'), false);
});

test('packageOf keeps the scope on scoped packages', () => {
  assert.equal(packageOf('framer-motion/dist/es'), 'framer-motion');
  assert.equal(packageOf('@gsap/react/dist/x'), '@gsap/react');
  assert.equal(packageOf('react'), 'react');
});

test('cdnUrl pins React and makes everything else share it', () => {
  // Two React instances on one page means two dispatchers and an invalid hook
  // call on the second section that mounts.
  assert.match(cdnUrl('react'), /\/react@19\.\d+\.\d+$/);
  assert.match(cdnUrl('react-dom/client'), /\/react-dom@19\.\d+\.\d+\/client$/);
  assert.match(cdnUrl('framer-motion'), /\/framer-motion\?external=react,react-dom$/);
  assert.match(cdnUrl('@gsap/react'), /\/@gsap\/react\?external=react,react-dom$/);
});

test('buildImportMap merges every section into the one map a document allows', () => {
  const map = buildImportMap(['react', 'react-dom/client', 'framer-motion', './App', 'react']);
  assert.equal(map.imports['react'], cdnUrl('react'));
  assert.equal(map.imports['react-dom/client'], cdnUrl('react-dom/client'));
  assert.ok(map.imports['react-dom'], 'the package root is mapped for deep imports');
  assert.ok(map.imports['react-dom/'], 'the trailing-slash prefix is mapped too');
  assert.equal(map.imports['./App'], undefined);              // a project file, not a dependency
  assert.deepEqual(Object.keys(map.imports), [...Object.keys(map.imports)].sort());
});

test('retargetMount sends each section to its own container', () => {
  // Every project mounts to #root because each owned a document; on a composed
  // page the second one would mount into the first and erase it.
  const id = rootIdFor('work');
  assert.equal(rootIdFor('work'), 'react-root-work');
  assert.ok(retargetMount('createRoot(document.getElementById("root"))', id).includes(`getElementById("${id}")`));
  assert.ok(retargetMount("createRoot(document.getElementById('root'))", id).includes(`getElementById("${id}")`));
  assert.ok(retargetMount('document.querySelector("#root")', id).includes(`getElementById("${id}")`));
  // Anything else is left alone.
  assert.equal(retargetMount('document.getElementById("hero")', id), 'document.getElementById("hero")');
});
