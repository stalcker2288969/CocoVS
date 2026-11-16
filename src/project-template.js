'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const template = require('./project-template.json');

async function initializeProject(root, target, architecture = 'vonNeumann') {
  const exists = file => fs.stat(path.join(root, file)).then(stat => stat.isFile(), error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  const existingEntry = await exists(template.entry) ? template.entry : await exists('main.asm') ? 'main.asm' : undefined;
  const entry = existingEntry ?? template.entry;
  const config = {entry, target, architecture, environment: target.endsWith('e') ? 'external' : 'emulator', extraSources: []};
  if (target === 'custom') {
    config.assembler = {command: './tools/assembler', args: ['-o', '${image}', '${sources}']};
    config.instructions = [];
  }
  const files = {'cdm-project.json': JSON.stringify(config, null, 2) + '\n',
    'README.md': template.readme.replaceAll('{{name}}', path.basename(root)), '.gitignore': template.gitignore};
  if (!existingEntry) {
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
