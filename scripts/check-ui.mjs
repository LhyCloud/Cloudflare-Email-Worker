/**
 * 开发期自检：核对 app.js / index.html 里用到的 class 是否都在 styles.css 中定义，
 * 以及模板里是否有未闭合的常见问题。仅本地使用，不进入构建产物。
 */
import fs from 'node:fs';

const app = fs.readFileSync('src/ui/app.js', 'utf8');
const css = fs.readFileSync('src/ui/styles.css', 'utf8');
const html = fs.readFileSync('src/ui/index.html', 'utf8');

const used = new Set();
const collect = (text) => {
  for (const m of text.matchAll(/class="([^"$]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/'([^']+)'/g)) for (const c of s[1].split(/\s+/)) if (c) used.add(c);
  }
  for (const m of text.matchAll(/className\s*=\s*'([^']+)'/g)) {
    for (const c of m[1].split(/\s+/)) if (c) used.add(c);
  }
};
collect(app);
collect(html);

const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const runtimeClasses = ['ok', 'err', 'is-open', 'loading'];
const missing = [...used].filter((c) => !defined.has(c) && !runtimeClasses.includes(c));

console.log(`app.js/html 使用 class：${used.size} 个`);
console.log(`styles.css 定义选择器：${defined.size} 个`);
console.log(missing.length ? `⚠ 未定义的 class：${missing.join(', ')}` : '✓ 所有 class 都有样式定义');

// 变量使用检查：CSS 里引用的 var(--x) 是否都有定义
const cssVars = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
const missingVars = [...usedVars].filter((v) => !cssVars.has(v));
console.log(missingVars.length ? `⚠ 未定义的 CSS 变量：${missingVars.join(', ')}` : `✓ ${usedVars.size} 个 CSS 变量均有定义`);

// 简单的标签配平检查（只针对自建模板）
for (const tag of ['div', 'section', 'aside', 'main', 'button', 'form', 'header']) {
  const open = (app.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (app.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) console.log(`⚠ <${tag}> 开合不一致：${open} / ${close}`);
}
console.log('✓ 模板标签配平检查完成');

/* ---- 阅读器顺序：外链图片提醒条要在正文上方 ---- */
const noticeIndex = app.indexOf('${blockedImages}');
const paperIndex = app.indexOf('<div class="mail-paper">');
if (noticeIndex < 0 || paperIndex < 0 || noticeIndex > paperIndex) {
  console.log('⚠ 「显示图片」提醒条应在正文（.mail-paper）之前渲染');
} else {
  console.log('✓ 「显示图片」提醒条位于正文上方');
}

/* ---- 布局不变量：整页锁定视口高度，长正文不能把侧栏顶出屏幕 ---- */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{`, 'm').exec(css);
  if (!match) return '';
  const start = match.index + match[0].indexOf(selector);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end < 0 ? css.length : end);
}

const layoutChecks = [
  ['.shell', /grid-template-rows:\s*minmax\(0,\s*1fr\)/],
  ['.shell', /height:\s*100dvh/],
  ['.rail', /min-height:\s*0/],
  ['.list-pane', /min-height:\s*0/],
  ['.reader', /min-height:\s*0/],
  ['.reader-scroll', /min-height:\s*0/],
];
const brokenLayout = layoutChecks.filter(([selector, pattern]) => !pattern.test(rule(selector)));
if (brokenLayout.length) {
  for (const [selector] of brokenLayout) console.log(`⚠ ${selector} 缺少锁定高度的声明（长邮件会把侧栏挤出屏幕）`);
} else {
  console.log('✓ 三栏高度锁定检查通过（侧栏底部按钮不会被长正文挤出视口）');
}
