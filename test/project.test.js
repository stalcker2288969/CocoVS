'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveSources,syncConfigs,loadProject,readJsonc}=require('../src/project');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cdm-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function put(root,file,text){const f=path.join(root,file);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);}
const conf={entry:'main.asm',target:'cdm8',architecture:'vonNeumann',environment:'external',extraSources:[]};
test('transitive dependencies and deduplication (entry first)',t=>{
  const root=fixture(t);
  put(root,'main.asm','# @include "lib/math.asm"\n# @include "lib/common.asm"\nasect 0\n');
  put(root,'lib/math.asm','# @include "common.asm"\n');
  put(root,'lib/common.asm','');
  assert.deepEqual(resolveSources(root,conf),['main.asm','lib/math.asm','lib/common.asm']);
});
test('rejects cyclic dependencies',t=>{
  const root=fixture(t);
  put(root,'main.asm','# @include "lib/a.asm"\n');
  put(root,'lib/a.asm','# @include "../main.asm"\n');
  assert.throws(()=>resolveSources(root,conf),/Cyclic @include/);
});
test('rejects path escape and missing dependencies',t=>{
  const root=fixture(t);
  put(root,'main.asm','# @include "../private.asm"\n');
  assert.throws(()=>resolveSources(root,conf),/escapes workspace/);
  put(root,'main.asm','# @include "missing.asm"\n');
  assert.throws(()=>resolveSources(root,conf),/Missing assembly dependency/);
});
test('extraSources included exactly once',t=>{
  const root=fixture(t);
  put(root,'main.asm','# @include "lib.asm"\n');put(root,'lib.asm','');put(root,'extra.asm','');
  assert.deepEqual(resolveSources(root,{...conf,extraSources:['lib.asm','extra.asm']}),['main.asm','lib.asm','extra.asm']);
});
test('sync updates managed task/debug configuration while preserving other entries',t=>{
  const root=fixture(t);const vs=path.join(root,'.vscode');fs.mkdirSync(vs);
  put(root,'.vscode/tasks.json','{ // comment\n "version":"2.0.0", "tasks":[{"label":"Unrelated","type":"shell","command":"echo ok"},],\n}');
  put(root,'.vscode/launch.json','{"version":"0.2.0","configurations":[{"name":"Unrelated","type":"node","request":"launch"}]}');
  syncConfigs(root,conf);syncConfigs(root,conf);
  const tasks=readJsonc(path.join(vs,'tasks.json'),{}).tasks;
  const launch=readJsonc(path.join(vs,'launch.json'),{}).configurations;
  assert.equal(tasks.length,2);assert.equal(launch.length,2);
  assert.deepEqual(tasks[1], {label:'CdM Project: Compile',type:'cocovs',group:'build',problemMatcher:[]});
  assert.equal(launch[1].preLaunchTask, undefined);
});
test('keeps CdM-8 local run independent of its CDP debugger mode', t => {
  const root = fixture(t);
  put(root, 'cdm-project.json', JSON.stringify({...conf, environment: 'emulator'}));
  const config = loadProject(root);
  assert.equal(config.environment, 'emulator');
  assert.equal(syncConfigs(root, config).session.type, 'cocovs-debug');
  put(root, 'cdm-project.json', JSON.stringify({...conf, address: 'https://localhost'}));
  assert.throws(() => loadProject(root), /valid ws:/);
});
