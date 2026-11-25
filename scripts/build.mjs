/**
 * 零依赖构建脚本：
 *  1. 把 src/*.js 的 ESM 模块按依赖顺序内联成单文件 dist/worker.js（可直接粘贴到控制台）
 *  2. 把 src/ui 的 CSS / JS 内联进 HTML，并注入 worker
 *  3. 额外输出 dist/index.html 便于本地预览
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'src', 'index.js');
const distDir = path.join(root, 'dist');

const modules = [];
const seen = new Set();
const declarationOwners = new Map();

async function collect(file) {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);

  const source = await readFile(resolved, 'utf8');
  const importPattern = /^import\s+[^;]*?from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
  const specs = [];
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const spec = match[1];
    if (!spec.startsWith('.')) throw new Error(`不支持非相对路径导入：${spec}（${resolved}）`);
    specs.push(path.resolve(path.dirname(resolved), spec));
  }

  for (const dep of specs) await collect(dep);

  const stripped = source
    .replace(importPattern, '')
    .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '')
    .replace(/^export\s+default\s+/m, 'const __workerEntry = ')
    .trim();

  const declPattern = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let decl;
  while ((decl = declPattern.exec(stripped)) !== null) {
    const name = decl[1] || decl[2];
    const owner = declarationOwners.get(name);
    if (owner && owner !== resolved) {
      throw new Error(`重复的顶层声明 "${name}"：${path.relative(root, owner)} 与 ${path.relative(root, resolved)}`);
    }
    declarationOwners.set(name, resolved);
  }

  modules.push({ file: resolved, code: stripped });
}

function escapeForInlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

async function buildHtml() {
  const uiDir = path.join(root, 'src', 'ui');
  const [template, css, js] = await Promise.all([
    readFile(path.join(uiDir, 'index.html'), 'utf8'),
    readFile(path.join(uiDir, 'styles.css'), 'utf8'),
    readFile(path.join(uiDir, 'app.js'), 'utf8'),
  ]);
  const html = template
    .replace('/*__STYLES__*/', () => css.trim())
    .replace('/*__SCRIPTS__*/', () => escapeForInlineScript(js.trim()));
  if (html.includes('/*__STYLES__*/') || html.includes('/*__SCRIPTS__*/')) {
    throw new Error('界面模板中的内联占位符未被替换');
  }
  return html;
}

async function main() {
  await collect(entry);
  const html = await buildHtml();

  let code = modules.map((mod) => mod.code).join('\n\n');
  if (!code.includes('/*__APP_HTML__*/')) throw new Error('index.js 缺少 APP_HTML 占位符');
  code = code.replace('/*__APP_HTML__*/ \'\'', () => JSON.stringify(html));

  const banner = [
    '// Cloud Mail —— 构建产物，请勿直接修改。',
    '// 源码：src/ ，构建：npm run build',
    `// 生成时间：${new Date().toISOString()}`,
    '',
  ].join('\n');

  const output = `${banner}${code.trim()}\n\nexport default __workerEntry;\n`;

  await mkdir(distDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(distDir, 'worker.js'), output, 'utf8'),
    writeFile(path.join(distDir, 'index.html'), html, 'utf8'),
  ]);

  const kb = (Buffer.byteLength(output) / 1024).toFixed(1);
  console.log(`✓ dist/worker.js  ${kb} KB（${modules.length} 个模块）`);
  console.log(`✓ dist/index.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
}

main().catch((error) => {
  console.error('构建失败：', error.message);
  process.exitCode = 1;
});
