/**
 * 批量下载结束后的汇报。
 *
 * 用户明确要求过：**遇到下不来的文件不要停，结束时告诉我成功多少、失败多少，
 * 并把失败的文件列一下**。这个文件钉住的就是那个汇报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportDownload, reportUpload } from '../src/extension';
import { Logger } from '../src/vscode/logger';
import { __vscodeTest } from './helpers/vscodeStub';

const ok = (downloaded: number, skipped = 0) => ({ downloaded, skipped, failed: [] });

test('全部成功：报成功数，不打扰', () => {
  __vscodeTest.reset();
  reportDownload(new Logger(), ok(12), '整个项目已下载到本地');

  const out = __vscodeTest.outputLines().join('\n');
  assert.match(out, /成功 12 个/);
  assert.equal(__vscodeTest.warningMessages().length, 0, '没有失败就不该弹警告');
  assert.ok(
    __vscodeTest.infoMessages().some((m) => m.includes('成功 12 个')),
    `应该有一条成功提示，实际：${JSON.stringify(__vscodeTest.infoMessages())}`,
  );
});

test('有失败：报"成功 N 个、失败 M 个"，并把失败清单逐条写进日志', () => {
  __vscodeTest.reset();
  reportDownload(
    new Logger(),
    {
      downloaded: 3,
      skipped: 1,
      failed: [
        {
          remotePath: '/.user.ini',
          localPath: 'E:\\proj\\.user.ini',
          error: "远程操作失败：RETR .user.ini → 550 Can't open .user.ini: No such file or directory",
        },
        { remotePath: '/runtime/cache.php', localPath: 'E:\\proj\\runtime\\cache.php', error: '连接被重置' },
      ],
    },
    '整个项目已下载到本地',
  );

  const out = __vscodeTest.outputLines().join('\n');
  // ① 汇总：成功/失败/跳过都要说清楚
  assert.match(out, /成功 3 个，失败 2 个/);
  assert.match(out, /跳过 1 个/);
  // ② 失败清单逐条列出，并且带上服务器的原话
  assert.match(out, /\/\.user\.ini —— .*550/);
  assert.match(out, /\/runtime\/cache\.php —— 连接被重置/);
  // ③ 明确告诉用户"其余都已下载"，免得误以为全挂了
  const warnings = __vscodeTest.warningMessages().join('\n');
  assert.match(warnings, /成功 3 个，失败 2 个/);
  assert.match(warnings, /其余文件都已下载/);
});

test('一个都没成功也不会谎报成功', () => {
  __vscodeTest.reset();
  reportDownload(
    new Logger(),
    { downloaded: 0, skipped: 0, failed: [{ remotePath: '/a', localPath: 'l', error: '炸了' }] },
    '下载',
  );

  const out = __vscodeTest.outputLines().join('\n');
  assert.match(out, /成功 0 个，失败 1 个/);
  assert.ok(!/成功 [1-9]/.test(out), '不该出现任何非零的成功数');
});

test('上传的汇报也是同一套口径（成功/失败/失败清单）', () => {
  __vscodeTest.reset();
  reportUpload(new Logger(), {
    uploaded: 5,
    skipped: 2,
    failed: [{ localPath: 'E:\\p\\a.php', error: 'Permission denied' }],
  });

  const out = __vscodeTest.outputLines().join('\n');
  assert.match(out, /成功 5 个，失败 1 个/);
  assert.match(out, /a\.php：Permission denied/);
  assert.match(__vscodeTest.errorMessages().join('\n'), /成功 5 个，失败 1 个/);
});

