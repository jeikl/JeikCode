import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseHomePath,
  displayPath,
  fsBreadcrumbs,
  isLoopbackHost,
  joinFsChild,
  pathBasename,
  stripExtendedPathPrefix,
} from './displayPath.ts';

test('strips Windows extended path prefix', () => {
  assert.equal(stripExtendedPathPrefix('\\\\?\\E:\\desktop'), 'E:\\desktop');
  assert.equal(stripExtendedPathPrefix('//?/E:/desktop'), 'E:/desktop');
  assert.equal(
    stripExtendedPathPrefix('\\\\?\\UNC\\server\\share\\x'),
    '\\\\server\\share\\x',
  );
  assert.equal(stripExtendedPathPrefix('/home/u/proj'), '/home/u/proj');
});

test('displayPath collapses home and strips extended prefix', () => {
  assert.equal(displayPath('\\\\?\\E:\\desktop'), 'E:\\desktop');
  assert.equal(displayPath('/Users/me/code/agents'), '~/code/agents');
});

test('pathBasename is separator-agnostic', () => {
  assert.equal(pathBasename('\\\\?\\E:\\desktop'), 'desktop');
  assert.equal(pathBasename('E:\\foo\\bar'), 'bar');
  assert.equal(pathBasename('/home/u/proj'), 'proj');
});

test('collapseHomePath handles Windows Users', () => {
  assert.equal(collapseHomePath('C:\\Users\\me\\proj'), '~\\proj');
});

test('strips slash-folded and one-slash-dropped extended prefixes', () => {
  assert.equal(stripExtendedPathPrefix('//?/E:/code/Jeikcode'), 'E:/code/Jeikcode');
  assert.equal(stripExtendedPathPrefix('/?/E:/code/Jeikcode'), 'E:/code/Jeikcode');
  assert.equal(stripExtendedPathPrefix('//?/UNC/server/share/x'), '//server/share/x');
  assert.equal(stripExtendedPathPrefix('/?/UNC/server/share/x'), '//server/share/x');
  assert.equal(stripExtendedPathPrefix('/?/not-a-drive'), '/?/not-a-drive');
});

test('drive paths E:/ and D:/ stay drive letters, never a question-mark segment', () => {
  const e = fsBreadcrumbs('E:/xxxx');
  assert.deepEqual(e.map((c) => c.label), ['E:', 'xxxx']);
  assert.equal(e[0].fullPath, 'E:/');
  assert.equal(e[1].fullPath, 'E:/xxxx');

  const d = fsBreadcrumbs('D:/xxx/src');
  assert.deepEqual(d.map((c) => c.label), ['D:', 'xxx', 'src']);
  assert.deepEqual(d.map((c) => c.fullPath), ['D:/', 'D:/xxx', 'D:/xxx/src']);

  const wide = fsBreadcrumbs('E：/xxxx');
  assert.deepEqual(wide.map((c) => c.label), ['E:', 'xxxx']);
  assert.equal(wide[1].fullPath, 'E:/xxxx');

  for (const raw of ['\\\\?\\E:\\xxxx', '//?/D:/xxx', '/?/E:/xxxx', 'E:/xxxx', 'D:\\xxx']) {
    const crumbs = fsBreadcrumbs(raw);
    assert.ok(crumbs.every((c) => c.label !== '?' && !c.fullPath.includes('/?/') && !c.fullPath.includes('\\\\?\\')));
    assert.match(crumbs[0].label, /^[A-Za-z]:$/);
  }
});

test('breadcrumbs never surface a ? segment for extended Windows paths', () => {
  const fromVerbatim = fsBreadcrumbs('\\\\?\\E:\\code\\Jeikcode');
  assert.deepEqual(fromVerbatim.map((c) => c.label), ['E:', 'code', 'Jeikcode']);
  assert.equal(fromVerbatim[0].fullPath, 'E:\\');
  assert.equal(fromVerbatim[2].fullPath, 'E:\\code\\Jeikcode');

  const fromSlash = fsBreadcrumbs('//?/E:/code/Jeikcode');
  assert.deepEqual(fromSlash.map((c) => c.label), ['E:', 'code', 'Jeikcode']);
  assert.equal(fromSlash[2].fullPath, 'E:/code/Jeikcode');
  assert.ok(!fromSlash.some((c) => c.label === '?' || c.fullPath.includes('/?/')));

  const dropped = fsBreadcrumbs('/?/E:/desktop');
  assert.deepEqual(dropped.map((c) => c.label), ['E:', 'desktop']);

  const unc = fsBreadcrumbs('//?/UNC/server/share/src');
  assert.equal(unc[0].fullPath, '//server/share');
  assert.equal(unc[1].fullPath, '//server/share/src');
  assert.ok(!unc.some((c) => c.label === '?'));
});

test('loopback hosts may open a native folder dialog', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('192.168.1.20'), false);
  assert.equal(isLoopbackHost('jeik.example.com'), false);
});

test('joinFsChild keeps drive roots and does not append onto a ? prefix', () => {
  assert.equal(joinFsChild('\\\\?\\E:\\code', 'Jeikcode'), 'E:\\code\\Jeikcode');
  assert.equal(joinFsChild('//?/E:/code', 'Jeikcode'), 'E:/code/Jeikcode');
  assert.equal(joinFsChild('/?/E:/code', 'src'), 'E:/code/src');
  assert.equal(joinFsChild('E:\\', 'code'), 'E:\\code');
  assert.equal(joinFsChild('C:', 'Users'), 'C:/Users');
  assert.equal(joinFsChild('/home/u', 'proj'), '/home/u/proj');
  assert.equal(joinFsChild('//server/share', 'src'), '//server/share/src');
});
