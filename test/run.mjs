/**
 * 单工具调试运行器：把插件当成 CLI 用，方便「跑一次真环境、看真输出」。
 *
 *   node test/run.mjs train_hunt '{"query":"千恋"}'
 *   node test/run.mjs train_hunt '{"roots":["./games"]}'
 *
 * 与 live.mjs 的区别：live 是固定的只读自检清单，本文件可传任意参数。
 */
const registered = [];
const ctx = {
  logger: { info: () => {}, warn: (m) => console.warn('[warn]', m), error: (m) => console.error('[err]', m) },
  get: (k) => (k === 'tools' ? { register: (d) => registered.push(d) } : undefined),
};

const mod = await import('../src/index.js');
await mod.apply(ctx, {});

const name = process.argv[2];
if (!name) {
  console.error('用法: node test/run.mjs <工具名> [JSON 参数]');
  console.error(`可用: ${registered.map((t) => t.name).join(', ')}`);
  process.exit(2);
}

const t = registered.find((x) => x.name === name);
if (!t) {
  console.error(`✗ 没有工具 ${name}`);
  process.exit(2);
}

let args = {};
if (process.argv[3]) {
  try {
    args = JSON.parse(process.argv[3]);
  } catch (e) {
    console.error(`✗ 参数不是合法 JSON: ${e.message}`);
    process.exit(2);
  }
}

const started = Date.now();
const res = await t.execute(args);
console.log(t.output.render(args, res)[0].text);
console.log(`\n[ok=${res.ok} · ${Date.now() - started}ms]`);
if (!res.ok) process.exitCode = 1;
