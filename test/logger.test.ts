/**
 * 日志分层的测试。
 *
 * 用户提过两个明确要求：
 *   1. 主日志只放**结果**（传了哪些文件、成功/失败、失败原因、基线建立），
 *      FTP/SFTP 的命令往来（CWD / 250 / EPSV / STOR / 150 / 226）不要混进来。
 *   2. 协议往来**不要一直写日志** —— VSCode 会把输出频道镜像到磁盘，日志文件会越来越大。
 *
 * 所以协议往来先待在内存的滚动缓冲里，只在出错/告警/主动查看时倒进独立频道。
 * 这个文件把这几条都钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../src/vscode/logger';
import { __vscodeTest } from './helpers/vscodeStub';

/** 真实 FTP 会话里会出现的东西，一条都不该漏进主日志。 */
const PROTOCOL_NOISE = [
  '> CWD /addons/app/api',
  '< 250 OK. Current directory is /addons/app/api',
  '> EPSV',
  '< 229 Extended Passive mode OK (|||39761|)',
  '> STOR /addons/app/index.go (520 字节)',
  '< 150',
  '< 226',
  '> TYPE I',
  '< 200 Type set to I',
];

test('日志分层：协议往来只进"协议细节"频道，主日志里一条都看不到', () => {
  __vscodeTest.reset();
  const logger = new Logger();

  // 正常的一次上传会同时产生结果日志和协议日志
  logger.info('↑ addons/hgexample/api/admin/index/index.go → /addons/...（520 B，79ms）');
  for (const line of PROTOCOL_NOISE) logger.trace(line);
  logger.info('启动同步：首次启用，已建立基线 —— 记录 128 个文件（账本现有 128 条）。');
  logger.warn('跳过删除 /x：远程内容和基线记录不一致，可能是别人放的文件');
  logger.error('上传失败：addons/app/index.go', new Error('连接被重置'));

  const main = __vscodeTest.outputLines().join('\n');
  const trace = __vscodeTest.traceLines().join('\n');

  // ① 主日志：有结果
  assert.ok(main.includes('↑ addons/hgexample/api/admin/index/index.go'), '主日志要有"传了哪个文件"');
  assert.ok(main.includes('已建立基线'), '主日志要有基线建立');
  assert.ok(main.includes('跳过删除 /x'), '主日志要有跳过原因');
  assert.ok(main.includes('上传失败：addons/app/index.go'), '主日志要有失败信息');

  // ② 主日志：一条协议往来都没有
  for (const noise of PROTOCOL_NOISE) {
    assert.ok(!main.includes(noise), `主日志里不该出现协议行「${noise}」`);
  }
  // 更宽一点的兜底：任何以 "> " / "< " 开头的协议行都不该在主日志里
  const strayProtocolLines = __vscodeTest
    .outputLines()
    .filter((l) => /\]\s*[<>]\s/.test(l) || /\]\s+(CWD|EPSV|PASV|PORT|EPRT|STOR|RETR)\b/.test(l));
  assert.deepEqual(strayProtocolLines, [], `主日志里残留了协议行：${JSON.stringify(strayProtocolLines)}`);

  // ③ 出过错 → 之前攒的协议往来被倒进了协议频道，排查时有得看
  for (const noise of PROTOCOL_NOISE) {
    assert.ok(trace.includes(noise), `出错后协议频道应该记下「${noise}」`);
  }
  assert.ok(!trace.includes('已建立基线'), '结果类日志不该跑到协议频道去');
});

test('协议往来不写日志：没出错时频道里一个字都没有（这是"日志不会越来越大"的关键）', () => {
  __vscodeTest.reset();
  const logger = new Logger();

  // 模拟一次「上传整个项目」：几千行协议往来，但全都成功
  logger.info('连接就绪 ftp://1.2.3.4:21（握手 + 登录 117ms，之后复用）');
  for (let i = 0; i < 500; i++) {
    logger.trace(`> STOR /site/file${i}.go (${i} 字节)`);
    logger.trace('< 150');
    logger.trace('< 226');
    logger.info(`↑ file${i}.go（${i} B，70ms）`);
  }

  assert.equal(
    __vscodeTest.traceLines().length,
    0,
    `没出错时协议频道不该有任何内容，实际有 ${__vscodeTest.traceLines().length} 行`,
  );
  // 主日志照常有结果
  assert.equal(__vscodeTest.outputLines().filter((l) => l.includes('↑ file')).length, 500);
});

test('出错时倒出的是"最近"的协议往来，且缓冲区有上限不会撑爆内存', () => {
  __vscodeTest.reset();
  const logger = new Logger();

  // 塞进去远超缓冲上限的行
  for (let i = 0; i < 2000; i++) logger.trace(`> NOOP ${i}`);
  logger.error('上传失败：boom.go', new Error('炸了'));

  const trace = __vscodeTest.traceLines();
  const protocolLines = trace.filter((l) => l.includes('> NOOP'));
  assert.ok(protocolLines.length > 0, '出错后应该倒出协议往来');
  assert.ok(
    protocolLines.length <= 400,
    `缓冲区必须有上限（400 行），实际倒出了 ${protocolLines.length} 行`,
  );
  // 倒出来的应该是最近的，不是最早的
  assert.ok(trace.some((l) => l.includes('> NOOP 1999')), '应该保留最近的协议往来');
  assert.ok(!trace.some((l) => l.includes('> NOOP 0\n')), '最早期的不该还留着');
  assert.ok(
    trace.some((l) => l.includes('出错：上传失败：boom.go')),
    '倒出的内容要标明是因为什么倒出来的',
  );

  // 倒过一次就清空了，不会重复写
  logger.error('又炸了');
  assert.equal(
    __vscodeTest.traceLines().filter((l) => l.includes('> NOOP')).length,
    protocolLines.length,
    '倒过一次之后不该重复倒同一批内容',
  );
});

test('主动执行「显示协议细节日志」时也会倒出缓冲（复现一次再看就够）', () => {
  __vscodeTest.reset();
  const logger = new Logger();

  logger.trace('> EPSV');
  logger.trace('< 229 Extended Passive mode OK (|||39761|)');
  logger.showTrace();

  const trace = __vscodeTest.traceLines();
  assert.ok(trace.some((l) => l.includes('手动查看')), '应该标出是手动查看触发的');
  assert.ok(trace.some((l) => l.includes('> EPSV')));
});

test('日志分层：错误详情留在主频道，协议频道不掺结果日志', () => {
  __vscodeTest.reset();
  const logger = new Logger();

  logger.error('出了点事', new Error('第一行\n第二行'));
  const main = __vscodeTest.outputLines().join('\n');
  assert.ok(main.includes('第一行'));
  assert.ok(main.includes('第二行'));
  assert.equal(__vscodeTest.traceLines().length, 0, '没有协议往来时协议频道应该是空的');
});

test('关闭扩展时会把还没倒出的协议往来落一次盘（卡住但不报错的情况只能靠它）', () => {
  __vscodeTest.reset();
  const logger = new Logger();

  logger.trace('> LIST');
  logger.info('列目录卡住了…');
  assert.equal(__vscodeTest.traceLines().length, 0);
  logger.dispose();

  const trace = __vscodeTest.traceLines();
  assert.ok(trace.some((l) => l.includes('扩展关闭')), '关闭时应该倒一次');
  assert.ok(trace.some((l) => l.includes('> LIST')));
});
