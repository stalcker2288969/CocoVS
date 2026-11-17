'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const template = require('./project-template.json');

async function initializeProject(root, target, architecture = 'vonNeumann', {library = false} = {}) {
  const exists = file => fs.stat(path.join(root, file)).then(stat => stat.isFile(), error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  for (const name of ['cdm-project.json', 'cdm-package.json']) {
    if (await exists(name)) return JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
  }
  const existingEntry = await exists(template.entry) ? template.entry : await exists('main.asm') ? 'main.asm' : undefined;
  const entry = existingEntry ?? template.entry;
  const config = library ? {version: '0.1.0', name: path.basename(root).toLowerCase().replaceAll(' ', '-'), description: '', publisher: '',
    targets: [target], languageVersion: template.languageVersion, files: ['lib.asm', 'README.md'], dependencies: {}} :
    {entry, target, architecture, environment: target.endsWith('e') ? 'external' : 'emulator', extraSources: [],
      languageVersion: template.languageVersion, dependencies: {}};
  if (library && !/^[a-z][a-z0-9_-]{0,63}$/.test(config.name)) throw new Error('Use a lowercase package name such as my-library.');
  if (target === 'custom') {
    config.assembler = {command: './tools/assembler', args: ['-o', '${image}', '${sources}']};
    config.instructions = [];
  }
  const files = {[library ? 'cdm-package.json' : 'cdm-project.json']: JSON.stringify(config, null, 2) + '\n',
    'README.md': library ? '# ' + path.basename(root) + '\n\nAssembly library. Declare public files and dependencies in cdm-package.json.\n' :
      template.readme.replaceAll('{{name}}', path.basename(root)), '.gitignore': template.gitignore};
  if (library) files['lib.asm'] = template.librarySource;
  if (!library && !existingEntry) {
    files[entry] = template.sources[target];
    if (['cdm8', 'cdm16'].includes(target)) {
      files['project.yaml'] = template.testProject;
      files['tests.yaml'] = template.testSuite.replaceAll('{{target}}', target)
        .replaceAll('{{memory}}', architecture === 'vonNeumann' ? 'unified' : 'harvard');
    }
  }
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(root, name);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, content, {flag: 'wx'}).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  return config;
}

module.exports = {initializeProject};
