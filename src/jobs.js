'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {ASSEMBLY, MANIFEST, inferTarget, loadProject, locateProject, resolveSources} = require('./project');

function createJob({file, languageId = '', workspace, task = false, target = 'cdm8', architecture = 'vonNeumann', address = 'ws://localhost:7001'}) {
  if (!task && file && !ASSEMBLY.test(file) && path.basename(file) !== MANIFEST) file = undefined;
  const manifestRoot = task || !file
    ? (workspace && fs.existsSync(path.join(workspace, MANIFEST)) ? workspace : undefined)
    : locateProject(file, workspace ?? path.dirname(file));
  if (manifestRoot) {
    const config = loadProject(manifestRoot);
    return {root: manifestRoot, manifest: true, config, sources: resolveSources(manifestRoot, config)};
  }
  if (task || !file || !ASSEMBLY.test(file) || /\.mlb$/i.test(file)) {
    throw new Error('Open an assembly source or create a cdm-project.json.');
  }
  const root = workspace ?? path.dirname(file);
  const inferred = inferTarget(file, languageId, target);
  const config = {
    entry: path.relative(root, file), target: inferred, architecture, address,
    environment: inferred === 'cdm16' ? 'emulator' : 'external',
  };
  return {root, manifest: false, config, sources: resolveSources(root, config)};
}

module.exports = {createJob};
