// 打包脚本：把 TypeScript 源码编译成 VSCode 插件可以直接加载的 CommonJS bundle。
//
//   node esbuild.mjs            构建插件 -> dist/extension.js
//   node esbuild.mjs --watch    监听源码变化，自动重新构建
//   node esbuild.mjs --tests    构建测试文件 -> out-test/*.js（配合 node --test 使用）
//
// 实现上优先直接调用 esbuild 的原生二进制（stdio 继承），
// 找不到二进制时才退回 esbuild 的 JS API —— 两种方式产物完全一致。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const buildTests = process.argv.includes('--tests') || watch;

/** 当前平台对应的 esbuild 原生二进制路径。 */
function nativeBinary() {
  const plat = process.platform;
  const arch = process.arch;
  const key = `${plat}-${arch}`;
  const exe = plat === 'win32' ? 'esbuild.exe' : join('bin', 'esbuild');
  const candidates = [join('node_modules', '@esbuild', key, exe)];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 统一入口：有原生二进制就用它，否则退回 JS API。 */
async function runEsbuild(cliArgs, jsOptions) {
  const bin = nativeBinary();
  if (bin) {
    const result = spawnSync(bin, [...cliArgs, '--log-level=info'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`esbuild 退出码 ${result.status}`);
    return;
  }
  const esbuild = await import('esbuild');
  await esbuild.build(jsOptions);
}

const EXTERNALS = ['vscode', 'cpu-features', '*.node'];

function extensionArgs() {
  return [
    'src/extension.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node20',
    ...EXTERNALS.map((e) => `--external:${e}`),
    '--sourcemap',
    '--outfile=dist/extension.js',
  ];
}

const extensionJsOptions = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // vscode 由宿主注入；cpu-features / *.node 是 ssh2 的可选原生加速，
  // 缺失时 ssh2 会自动退回纯 JS 实现。
  external: EXTERNALS,
  sourcemap: true,
  logLevel: 'info',
};

/** 测试文件逐个打包，避免 node:test 的用例互相干扰。 */
function testEntryPoints() {
  try {
    return readdirSync('test')
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => join('test', f));
  } catch {
    return [];
  }
}

/** 测试里用到的第三方实现（FTP/SFTP 测试服务器、加密库）不需要打进 bundle，
 *  运行时从 node_modules 直接 require，编译更快也更好排查。
 *  `vscode` 这个模块只存在于 VSCode 宿主里，测试时用替身模块顶上。 */
const TEST_EXTERNALS = ['ftp-srv', 'ssh2', 'ssh2-sftp-client', 'selfsigned', 'iconv-lite'];
const VSCODE_ALIAS = { vscode: './test/helpers/vscodeStub.ts' };

function testArgs(entries) {
  return [
    ...entries,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node20',
    '--sourcemap',
    '--outdir=out-test',
    ...TEST_EXTERNALS.map((e) => `--external:${e}`),
    ...Object.entries(VSCODE_ALIAS).map(([from, to]) => `--alias:${from}=${to}`),
  ];
}

async function main() {
  if (watch) {
    const bin = nativeBinary();
    if (!bin) {
      const esbuild = await import('esbuild');
      const ctx = await esbuild.context(extensionJsOptions);
      await ctx.watch();
      console.log('[watch] 正在监听源码变化…');
      return;
    }
    const result = spawnSync(bin, [...extensionArgs(), '--watch', '--log-level=info'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    return;
  }

  mkdirSync('dist', { recursive: true });
  await runEsbuild(extensionArgs(), extensionJsOptions);
  console.log('[build] dist/extension.js 已生成');

  if (buildTests) {
    rmSync('out-test', { recursive: true, force: true });
    mkdirSync('out-test', { recursive: true });
    const entries = testEntryPoints();
    if (entries.length === 0) {
      console.log('[tests] 没有找到 test/*.test.ts');
      return;
    }
    await runEsbuild(testArgs(entries), {
      entryPoints: entries,
      outdir: 'out-test',
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      sourcemap: true,
      logLevel: 'info',
      external: TEST_EXTERNALS,
      alias: VSCODE_ALIAS,
    });
    console.log(`[tests] 已编译 ${entries.length} 个测试文件到 out-test/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
