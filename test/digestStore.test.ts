/**
 * 同步账本的测试。
 *
 * 账本必须能**跨 VSCode 重启存活** —— 因为"上次传到哪"正是重启之后最需要的信息，
 * 增量同步（哪些变了、哪些本地已删）全靠它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { connectionIdOf, digestKey, parseDigestKey } from '../src/core/digestStore';
import { WorkspaceDigestStore } from '../src/vscode/workspaceDigestStore';
import { createExtensionContext } from './helpers/vscodeStub';

test('账本键：连接信息和远程路径都能还原，而且能区分不同服务器', () => {
  const key = digestKey('sftp://u@h:22', '/a/b c.txt');
  assert.deepEqual(parseDigestKey(key), { connectionId: 'sftp://u@h:22', remotePath: '/a/b c.txt' });

  // 远程路径里带分隔符也不能把解析搞乱（路径里其实不可能有 NUL，这里只是防御）
  assert.equal(parseDigestKey('没有分隔符'), undefined);

  const serverA = connectionIdOf({ protocol: 'sftp', username: 'u', host: 'h', port: 22 });
  const serverB = connectionIdOf({ protocol: 'sftp', username: 'u', host: 'h2', port: 22 });
  const serverC = connectionIdOf({ protocol: 'sftp', username: 'u', host: 'h', port: 2222 });
  assert.notEqual(serverA, serverB);
  assert.notEqual(serverA, serverC);
  assert.notEqual(digestKey(serverA, '/x'), digestKey(serverB, '/x'));
});

test('账本：能跨实例持久化（等价于重开 VSCode）', async () => {
  const ctx = createExtensionContext() as unknown as vscode.ExtensionContext;
  const k1 = digestKey('sftp://u@h:22', '/a.txt');
  const k2 = digestKey('sftp://u@h:22', '/sub/b.txt');

  const first = new WorkspaceDigestStore(ctx);
  assert.equal(first.size, 0, '新工作区账本应该是空的');
  first.set(k1, 'hash-1');
  first.set(k2, 'hash-2');
  await first.flush();

  // 新实例 = 重开 VSCode
  const second = new WorkspaceDigestStore(ctx);
  assert.equal(second.size, 2, '重开之后账本必须还在');
  assert.equal(second.get(k1), 'hash-1');
  assert.equal(second.get(k2), 'hash-2');

  // 删除也要能持久化（否则重启后会以为远程文件还在，凭空多删一次）
  assert.equal(second.delete(k1), true);
  assert.equal(second.delete(k1), false, '删不存在的键应该返回 false');
  await second.flush();

  const third = new WorkspaceDigestStore(ctx);
  assert.deepEqual(third.keys(), [k2], '删除之后只剩剩下的那条');
  assert.equal(third.get(k2), 'hash-2');
});

test('账本：脏数据不会污染（非字符串值、缺分隔符的键都会被丢掉）', async () => {
  const ctx = createExtensionContext() as unknown as vscode.ExtensionContext;
  const state = ctx.workspaceState as unknown as { update: (k: string, v: unknown) => Promise<void> };
  await state.update('remoteFile.syncedDigests', {
    [digestKey('sftp://u@h:22', '/ok.txt')]: 'good',
    '缺分隔符的键': 'bad',
    [digestKey('sftp://u@h:22', '/num.txt')]: 123,
    [digestKey('sftp://u@h:22', '/null.txt')]: null,
  });

  const store = new WorkspaceDigestStore(ctx);
  assert.equal(store.size, 1);
  assert.equal(store.get(digestKey('sftp://u@h:22', '/ok.txt')), 'good');
});

test('账本：写盘有去抖，flush 之后才真正落盘', async () => {
  const ctx = createExtensionContext() as unknown as vscode.ExtensionContext;
  const key = digestKey('sftp://u@h:22', '/debounce.txt');

  const store = new WorkspaceDigestStore(ctx);
  store.set(key, 'v1');
  // 还没 flush：新实例读不到（这就是"去抖"的表现）
  assert.equal(new WorkspaceDigestStore(ctx).get(key), undefined);

  await store.flush();
  assert.equal(new WorkspaceDigestStore(ctx).get(key), 'v1');
});
