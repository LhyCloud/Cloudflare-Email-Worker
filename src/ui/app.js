/**
 * Cloud Mail 前端：零框架、单文件、事件委托驱动。
 * 通过 /api/* 与 Worker 通信，令牌保存在 localStorage。
 */
(() => {
  'use strict';

  /* ==================== 基础工具 ==================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ICONS = {
    mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.6"/><path d="m3.4 6.8 7.8 5.5a1.4 1.4 0 0 0 1.6 0l7.8-5.5"/>',
    'mail-open': '<path d="M3 10.3 12 3l9 7.3V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8.7Z"/><path d="m3 10.3 9 6.2 9-6.2"/>',
    star: '<path d="m12 3.7 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8L12 3.7Z"/>',
    send: '<path d="M21.4 2.6 10.7 13.3"/><path d="M21.4 2.6 14.7 21l-4-8.1-8.1-4 18.8-6.3Z"/>',
    reply: '<path d="M9.4 5.6 4 11l5.4 5.4"/><path d="M4 11h9a7 7 0 0 1 7 7v1"/>',
    trash: '<path d="M4 7h16"/><path d="M9.2 7V5.3A1.3 1.3 0 0 1 10.5 4h3a1.3 1.3 0 0 1 1.3 1.3V7"/><path d="m6.4 7 .8 12.1a2 2 0 0 0 2 1.9h5.6a2 2 0 0 0 2-1.9L17.6 7"/><path d="M10.4 11v6M13.6 11v6"/>',
    settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.6a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    users: '<path d="M16 20.5v-1.7a3.5 3.5 0 0 0-3.5-3.5H6.5A3.5 3.5 0 0 0 3 18.8v1.7"/><circle cx="9.5" cy="8" r="3.6"/><path d="M21 20.5v-1.7a3.5 3.5 0 0 0-2.6-3.4"/><path d="M16.4 4.7a3.6 3.6 0 0 1 0 6.9"/>',
    search: '<circle cx="11" cy="11" r="6.4"/><path d="m15.8 15.8 4.6 4.6"/>',
    x: '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
    refresh: '<path d="M20 11.2A8 8 0 1 0 17.6 17"/><path d="M20 4.6v6.6h-6.6"/>',
    pencil: '<path d="M4 20h4L18.6 9.4a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14.4 5.6 3 3"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    paperclip: '<path d="M20.4 11.6 12 20a4.9 4.9 0 0 1-7-6.9l8-8a3.3 3.3 0 0 1 4.7 4.6l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>',
    logout: '<path d="M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5"/><path d="m15 8 4 4-4 4"/><path d="M19 12H9.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2.2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
    plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
    key: '<circle cx="8" cy="15.8" r="3.6"/><path d="m10.6 13.2 6.6-6.6"/><path d="m15.4 8.4 2.2 2.2"/><path d="m17.6 6.2 2.2 2.2"/>',
    shield: '<path d="M12 3 5 5.4v6c0 4.4 3 7.4 7 9.6 4-2.2 7-5.2 7-9.6v-6L12 3Z"/><path d="m9.2 11.8 2 2 3.6-3.9"/>',
    alert: '<path d="M10.3 4.4 2.7 17.6a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0Z"/><path d="M12 9.4v4.2"/><circle cx="12" cy="17" r=".7" fill="currentColor" stroke="none"/>',
    check: '<path d="m5 12.6 4.6 4.6L19 7.4"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2.4"/><circle cx="8.4" cy="10" r="1.6"/><path d="m3.8 18 5-4.6 3.7 2.9 3-2.6 4.7 4.3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.4"/><circle cx="12" cy="7.8" r=".75" fill="currentColor" stroke="none"/>',
  };

  function icon(name, size = 18, extraClass = '') {
    const body = ICONS[name] || '';
    return `<svg class="${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">${body}</svg>`;
  }

  /** 读取表单字段值（避免与 HTMLFormElement 自身属性同名冲突）。 */
  function fv(form, name) {
    const field = form.elements.namedItem(name);
    return field && 'value' in field ? field.value : '';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name, email) {
    const source = String(name || '').trim() || String(email || '').split('@')[0] || '?';
    const parts = source.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }

  const AVATAR_COLORS = [
    ['#6366f1', '#4338ca'],
    ['#0ea5e9', '#0369a1'],
    ['#10b981', '#047857'],
    ['#f59e0b', '#b45309'],
    ['#ec4899', '#be185d'],
    ['#8b5cf6', '#6d28d9'],
    ['#14b8a6', '#0f766e'],
    ['#ef4444', '#b91c1c'],
  ];

  function avatarStyle(seed) {
    const text = String(seed || '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000;
    const [a, b] = AVATAR_COLORS[hash % AVATAR_COLORS.length];
    return `background:linear-gradient(145deg,${a},${b})`;
  }

  function avatar(name, email, size = '') {
    const cls = `avatar ${size}`.trim();
    return `<span class="${cls}" style="${avatarStyle(email || name)}" aria-hidden="true">${esc(initials(name, email))}</span>`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso).slice(0, 16);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const pad = (n) => String(n).padStart(2, '0');
    if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  function fmtFull(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function fmtBytes(bytes) {
    const size = Number(bytes || 0);
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  const SUBJECT_FALLBACK = '(无主题)';

  function displayName(name, email) {
    return String(name || '').trim() || String(email || '').split('@')[0] || '未知发件人';
  }

  /* ==================== 状态 ==================== */

  const LS_TOKEN = 'cm.token';
  const LS_THEME = 'cm.theme';
  const LS_LAST = 'cm.lastAddress';

  const state = {
    token: localStorage.getItem(LS_TOKEN) || '',
    theme: localStorage.getItem(LS_THEME) || 'auto',
    user: null,
    domain: '',
    domainSource: '',
    mailbox: '',
    canSendAs: false,
    trashTtlDays: 30,
    mailRetention: 0,
    keys: [],
    counts: { inbox: 0, unread: 0, starred: 0, trash: 0, sent: 0 },
    setup: { needsSetup: false, userCount: 0, defaultAdmin: '' },
    view: 'inbox',
    q: '',
    unreadOnly: false,
    page: 1,
    pageSize: 25,
    items: [],
    total: 0,
    listLoading: false,
    listSeq: 0,
    selectedId: null,
    mail: null,
    mailLoading: false,
    allowImages: false,
    modal: null,
  };

  const VIEW_META = {
    inbox: { title: '收件箱', box: 'inbox' },
    starred: { title: '星标', box: 'starred' },
    sent: { title: '已发送', box: 'sent' },
    trash: { title: '垃圾箱', box: 'trash' },
    settings: { title: '设置' },
    admin: { title: '账号管理' },
  };

  const isPageView = () => state.view === 'settings' || state.view === 'admin';

  /* ==================== 主题 ==================== */

  function applyTheme(theme) {
    state.theme = ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem(LS_THEME, state.theme);
    const next = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
    $$('[data-theme-toggle]').forEach((btn) => {
      btn.innerHTML = icon(state.theme === 'auto' ? 'monitor' : state.theme === 'dark' ? 'moon' : 'sun', 17);
      btn.title = `切换主题（当前：${{ auto: '跟随系统', light: '浅色', dark: '深色' }[state.theme]}）`;
      btn.dataset.nextTheme = next;
    });
  }

  /* ==================== 网络 ==================== */

  async function api(path, options = {}) {
    const { method = 'GET', body, auth = true } = options;
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && state.token) headers.authorization = `Bearer ${state.token}`;

    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('网络连接失败，请检查网络后重试');
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || (data && data.ok === false)) {
      const error = new Error((data && data.error && data.error.message) || `请求失败（${response.status}）`);
      error.code = data && data.error ? data.error.code : 'http_error';
      error.status = response.status;
      if (response.status === 401 && auth && state.token) handleSessionExpired();
      throw error;
    }
    return data || {};
  }

  /* ==================== 提示 ==================== */

  function toast(message, type = 'info') {
    const root = $('#toasts');
    if (!root) return;
    const node = document.createElement('div');
    node.className = `toast${type === 'danger' ? ' is-danger' : type === 'success' ? ' is-success' : ''}`;
    node.innerHTML = `${icon(type === 'danger' ? 'alert' : type === 'success' ? 'check' : 'info', 17)}<span>${esc(message)}</span>`;
    root.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 220);
    }, 3200);
  }

  /* ==================== 弹窗 ==================== */

  function openModal({ title, body, footer = '', size = '', onMount }) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" data-action="modal-backdrop">
        <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head">
            <h3>${esc(title)}</h3>
            <button class="icon-btn" data-action="modal-close" aria-label="关闭">${icon('x')}</button>
          </div>
          <div class="modal-body">${body}</div>
          ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
        </div>
      </div>`;
    state.modal = root.firstElementChild;
    const focusTarget = $('input:not([type=hidden]), textarea, select', state.modal);
    if (focusTarget) setTimeout(() => focusTarget.focus(), 40);
    if (onMount) onMount(state.modal);
  }

  function closeModal() {
    const root = $('#modal-root');
    if (root) root.innerHTML = '';
    state.modal = null;
  }

  function confirmDialog({ title = '确认操作', message, confirmText = '确认', danger = false }) {
    return new Promise((resolve) => {
      openModal({
        title,
        size: 'narrow',
        body: `<p style="margin:0;color:var(--text-2);font-size:13.5px;line-height:1.7">${esc(message)}</p>`,
        footer: `
          <div class="spacer"></div>
          <button class="btn btn-ghost" data-action="modal-close">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-ok">${esc(confirmText)}</button>`,
        onMount(node) {
          $('[data-action="confirm-ok"]', node).addEventListener('click', () => {
            closeModal();
            resolve(true);
          });
          node.addEventListener('click', (event) => {
            if (event.target === node) {
              closeModal();
              resolve(false);
            }
          });
          $('[data-action="modal-close"]', node).addEventListener('click', () => resolve(false));
        },
      });
    });
  }

  /* ==================== 登录 / 初始化 ==================== */

  function authError(node, message) {
    const box = $('.auth-error', node);
    if (!box) return;
    box.textContent = message;
    box.classList.toggle('is-visible', Boolean(message));
  }

  /** 地址输入框：识别到域名时只填前缀，域名作为后缀自动补齐。 */
  function addressInput({ id, name, label, value = '', placeholder = '前缀', autocomplete = 'username', hint = '', disabled = false }) {
    const field = `${label ? `<label for="${id}">${label}</label>` : ''}`;
    if (state.domain) {
      return `<div class="field">
        ${field}
        <div class="input-group">
          <input id="${id}" class="input" name="${name}" type="text" inputmode="email" autocomplete="${autocomplete}"
            value="${esc(value)}" placeholder="${esc(placeholder)}" ${disabled ? 'disabled' : 'required'} />
          <span class="affix">@${esc(state.domain)}</span>
        </div>
        ${hint ? `<span class="hint">${hint}</span>` : ''}
      </div>`;
    }
    return `<div class="field">
      ${field}
      <input id="${id}" class="input" name="${name}" type="text" inputmode="email" autocomplete="${autocomplete}"
        value="${esc(value)}" placeholder="${esc(placeholder === '前缀' ? 'admin@example.com' : placeholder)}" ${disabled ? 'disabled' : 'required'} />
      ${hint ? `<span class="hint">${hint}</span>` : ''}
    </div>`;
  }

  /** 把完整地址按当前域名拆成前缀，用于输入框回填。 */
  function prefixOfAddress(address) {
    const text = String(address || '').trim();
    if (!text) return '';
    if (!state.domain) return text;
    const suffix = `@${state.domain}`.toLowerCase();
    return text.toLowerCase().endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text;
  }

  /** 输入框里的内容 → 完整地址：只填前缀就自动补上 @域名。 */
  function addressValueOf(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.includes('@')) return text;
    return state.domain ? `${text}@${state.domain}` : text;
  }

  /** 记住上次登录的地址，下次打开登录页自动填上（只填前缀部分）。 */
  function rememberedAddress() {
    const saved = localStorage.getItem(LS_LAST) || '';
    if (!saved) return '';
    if (!state.domain) return saved;
    const suffix = `@${state.domain}`.toLowerCase();
    return saved.toLowerCase().endsWith(suffix) ? saved.slice(0, saved.length - suffix.length) : saved;
  }

  function rememberAddress(email) {
    try {
      if (email) localStorage.setItem(LS_LAST, email);
    } catch {
      /* 隐私模式下写不进去就算了 */
    }
  }

  function domainHint(extra = '') {
    if (state.domain) {
      return `收件域名 ${esc(state.domain)} 已自动识别${extra ? `，${extra}` : ''}`;
    }
    return '暂时无法识别收件域名：可以填完整地址，或在 wrangler.toml 里设置 MAIL_DOMAIN（收到第一封邮件后也会自动识别）';
  }

  function renderAuth() {
    const setup = state.setup.needsSetup;
    const themeBtn = `<button class="icon-btn auth-theme" data-action="toggle-theme" data-theme-toggle aria-label="切换主题"></button>`;
    app().innerHTML = `
      <div class="auth-screen">
        ${themeBtn}
        <div class="auth-card">
          <div class="auth-head">
            <span class="brand-mark">${icon('mail', 21)}</span>
            <div>
              <h1>${setup ? '初始化 Cloud Mail' : 'Cloud Mail'}</h1>
              <p>${setup ? '创建第一个管理员账号' : `登录你的邮箱${state.domain ? ` · @${esc(state.domain)}` : ''}`}</p>
            </div>
          </div>
          ${
            setup
              ? `
          <form class="auth-form" data-form="setup" novalidate>
            <div class="auth-error"></div>
            <div class="field">
              <label for="setup-name">显示名称</label>
              <input id="setup-name" class="input" name="name" autocomplete="name" placeholder="例如：林可" />
            </div>
            ${addressInput({
              id: 'setup-email',
              name: 'email',
              label: '管理员邮箱',
              value: state.setup.defaultAdmin ? state.setup.defaultAdmin.split('@')[0] : 'admin',
              placeholder: 'admin',
              hint: domainHint('管理员默认使用这个地址，需已在 Email Routing 中启用'),
            })}
            <div class="field">
              <label for="setup-password">登录密码</label>
              <input id="setup-password" class="input" name="password" type="password" autocomplete="new-password"
                placeholder="至少 8 位" required />
            </div>
            <div class="field">
              <label for="setup-confirm">确认密码</label>
              <input id="setup-confirm" class="input" name="confirm" type="password" autocomplete="new-password" required />
            </div>
            <button class="btn btn-primary btn-block" type="submit">创建管理员账号</button>
          </form>
          <div class="auth-foot">数据表会在首次运行时自动创建，无需手动执行 SQL。</div>`
              : `
          <form class="auth-form" data-form="login" novalidate>
            <div class="auth-error"></div>
            ${addressInput({
              id: 'login-email',
              name: 'email',
              label: '邮箱地址',
              value: rememberedAddress(),
              placeholder: state.domain ? '前缀，如 admin' : 'admin@example.com',
              hint: state.domain ? `${esc(state.domain)} 已自动识别，只填 @ 前面的部分` : '',
            })}
            <div class="field">
              <label for="login-password">密码</label>
              <input id="login-password" class="input" name="password" type="password" autocomplete="current-password" required />
            </div>
            <button class="btn btn-primary btn-block" type="submit">登录</button>
          </form>
          <div class="auth-foot">忘记密码？请让管理员在「账号管理」中重置。</div>`
          }
        </div>
      </div>`;
    applyTheme(state.theme);
    const first = $('input', app());
    if (first) setTimeout(() => first.focus(), 60);
  }

  async function submitLogin(form) {
    const submitBtn = $('button[type=submit]', form);
    authError(form, '');
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = '登录中…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          email: fv(form, 'email').trim(),
          password: fv(form, 'password'),
        },
      });
      state.token = data.token;
      localStorage.setItem(LS_TOKEN, data.token);
      rememberAddress(data.user && data.user.email);
      await bootApp(data.user);
    } catch (error) {
      authError(form, error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  }

  async function submitSetup(form) {
    const submitBtn = $('button[type=submit]', form);
    authError(form, '');
    if (fv(form, 'password') !== fv(form, 'confirm')) {
      authError(form, '两次输入的密码不一致');
      return;
    }
    if (String(fv(form, 'password')).length < 8) {
      authError(form, '密码至少需要 8 位');
      return;
    }
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = '创建中…';
    try {
      const data = await api('/api/setup', {
        method: 'POST',
        auth: false,
        body: {
          name: fv(form, 'name').trim(),
          email: fv(form, 'email').trim(),
          password: fv(form, 'password'),
        },
      });
      state.token = data.token;
      localStorage.setItem(LS_TOKEN, data.token);
      rememberAddress(data.user && data.user.email);
      state.setup.needsSetup = false;
      toast('初始化完成，欢迎使用 Cloud Mail', 'success');
      await bootApp(data.user);
    } catch (error) {
      authError(form, error.message);
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  }

  /* ==================== 主界面骨架 ==================== */

  function app() {
    return $('#app');
  }

  function shell() {
    return $('.shell');
  }

  function railBadge(count) {
    if (!count) return '';
    return `<span class="rail-badge">${count > 99 ? '99+' : count}</span>`;
  }

  function renderShell() {
    const user = state.user || {};
    const meta = VIEW_META[state.view] || VIEW_META.inbox;
    app().innerHTML = `
      <div class="shell${isPageView() ? ' shell--page' : ''}">
        <aside class="rail">
          <span class="brand-mark" title="Cloud Mail">${icon('mail', 21)}</span>
          <nav class="rail-nav" aria-label="主导航">
            ${railButton('inbox', 'mail', '收件箱', state.counts.unread)}
            ${railButton('starred', 'star', '星标')}
            ${railButton('sent', 'send', '已发送')}
            ${railButton('trash', 'trash', '垃圾箱')}
            <div class="rail-spacer"></div>
            ${user.role === 'admin' ? railButton('admin', 'users', '账号管理') : ''}
            ${railButton('settings', 'settings', '设置')}
          </nav>
          <div class="rail-user">
            <button data-action="user-menu" aria-label="账户">${avatar(user.name, user.email)}</button>
          </div>
        </aside>

        <section class="list-pane" aria-label="${esc(meta.title)}">
          <header class="list-head">
            <h2>${esc(meta.title)}</h2>
            <div class="head-actions">
              ${state.view === 'trash' ? `<button class="icon-btn" data-action="empty-trash" title="清空垃圾箱">${icon('trash')}</button>` : ''}
              <button class="icon-btn" data-action="compose" title="写邮件">${icon('pencil')}</button>
              <button class="icon-btn" data-action="refresh" title="刷新">${icon('refresh')}</button>
            </div>
          </header>
          <div class="search-wrap">
            ${icon('search', 15)}
            <input id="search" class="search-input" type="search" placeholder="搜索邮件…" autocomplete="off"
              value="${esc(state.q)}" aria-label="搜索邮件" />
            ${state.q ? `<button class="search-clear" data-action="clear-search" aria-label="清除">${icon('x', 13)}</button>` : ''}
          </div>
          <div class="chips">
            <button class="chip${state.unreadOnly ? '' : ' is-active'}" data-action="chip-all">全部</button>
            <button class="chip${state.unreadOnly ? ' is-active' : ''}" data-action="chip-unread">未读</button>
          </div>
          ${state.view === 'trash' ? `<p class="trash-hint">${icon('info', 13)}<span>垃圾箱邮件保留 ${state.trashTtlDays} 天后自动清除，右键可恢复</span></p>` : ''}
          <div class="mail-list" id="mail-list"></div>
        </section>

        <main class="reader" id="reader"></main>
      </div>`;
    applyTheme(state.theme);
    renderList();
    renderReader();
  }

  function railButton(view, iconName, label, badge = 0) {
    const active = state.view === view ? ' is-active' : '';
    return `<button class="rail-btn${active}" data-action="nav" data-view="${view}" data-tip="${label}" aria-label="${label}"
      ${active ? 'aria-current="page"' : ''}>${icon(iconName, 20)}${railBadge(badge)}</button>`;
  }

  function updateRail() {
    if (!shell() || isPageView()) return;
    $$('.rail-btn', shell()).forEach((btn) => {
      const active = btn.dataset.view === state.view;
      btn.classList.toggle('is-active', active);
      const badge = $('.rail-badge', btn);
      if (btn.dataset.view === 'inbox') {
        if (state.counts.unread > 0) {
          if (badge) badge.textContent = state.counts.unread > 99 ? '99+' : String(state.counts.unread);
          else btn.insertAdjacentHTML('beforeend', railBadge(state.counts.unread));
        } else if (badge) {
          badge.remove();
        }
      }
    });
    document.title = state.counts.unread > 0 ? `(${state.counts.unread}) Cloud Mail` : 'Cloud Mail';
  }

  /* ==================== 列表 ==================== */

  function renderList() {
    const list = $('#mail-list');
    if (!list) return;
    if (state.listLoading && state.items.length === 0) {
      list.innerHTML = Array.from({ length: 7 })
        .map(
          () => `<div class="sk-item">
            <div class="skeleton sk-line" style="width:38%"></div>
            <div class="skeleton sk-line" style="width:82%"></div>
            <div class="skeleton sk-line" style="width:64%"></div>
          </div>`,
        )
        .join('');
      return;
    }
    if (state.items.length === 0) {
      list.innerHTML = emptyListHtml();
      return;
    }
    const rows = state.items.map(mailItemHtml).join('');
    const more =
      state.items.length < state.total
        ? `<div class="list-more"><button data-action="load-more">加载更多（还有 ${state.total - state.items.length} 封）</button></div>`
        : '';
    list.innerHTML = rows + more;
    highlightActive();
  }

  function emptyListHtml() {
    const isSearch = Boolean(state.q);
    const messages = {
      inbox: isSearch ? '没有匹配的邮件' : '收件箱空空如也',
      starred: '还没有星标邮件',
      sent: '还没有发送记录',
      trash: '垃圾箱是空的',
    };
    const hints = {
      inbox: isSearch ? '换个关键词试试' : `发送到 @${state.domain || '你的域名'} 的邮件会出现在这里`,
      starred: '在阅读邮件时点击星标图标即可收藏',
      sent: '点击右上角的铅笔图标写第一封邮件',
      trash: '删除的邮件会先移到这里',
    };
    return `<div class="empty">
      <div class="empty-icon">${icon(isSearch ? 'search' : 'mail-open', 24)}</div>
      <strong>${esc(messages[state.view] || '没有邮件')}</strong>
      <p>${esc(hints[state.view] || '')}</p>
    </div>`;
  }

  function mailItemHtml(item) {
    const sent = state.view === 'sent';
    const whoName = sent ? item.to : displayName(item.fromName, item.from);
    const time = sent ? item.sentAt : item.receivedAt;
    const unread = !sent && !item.isRead;
    const ttlLeft = state.view === 'trash' && item.deletedAt
      ? state.trashTtlDays - Math.floor((Date.now() - Date.parse(item.deletedAt)) / 86400000)
      : null;
    const flags = [
      ttlLeft != null ? `<span class="badge">${ttlLeft > 0 ? `${ttlLeft} 天后清除` : '即将清除'}</span>` : '',
      !sent && item.isStarred ? `<span class="star" title="已加星标">${icon('star', 13)}</span>` : '',
      item.hasAttachments ? `<span class="clip" title="含附件">${icon('paperclip', 13)}</span>` : '',
      sent && item.status === 'failed' ? `<span class="badge badge-danger">失败</span>` : '',
    ]
      .filter(Boolean)
      .join('');
    return `<button class="mail-item${unread ? ' is-unread' : ''}${state.selectedId === item.id ? ' is-active' : ''}"
        data-action="open-mail" data-id="${item.id}" data-sent="${sent ? '1' : '0'}">
      <div class="mail-row1">
        <span class="mail-from">${esc(whoName)}</span>
        <span class="mail-time">${esc(fmtDate(time))}</span>
      </div>
      <div class="mail-subject">${esc(item.subject || SUBJECT_FALLBACK)}</div>
      <div class="mail-preview">${esc(item.preview || '')}</div>
      ${flags ? `<div class="mail-flags" style="margin-top:5px">${flags}</div>` : ''}
    </button>`;
  }

  function highlightActive() {
    $$('.mail-item', $('#mail-list') || document).forEach((node) => {
      node.classList.toggle('is-active', Number(node.dataset.id) === state.selectedId);
    });
  }

  async function loadList({ reset = false } = {}) {
    if (isPageView()) return;
    if (reset) {
      state.page = 1;
      state.items = [];
    }
    state.listLoading = true;
    const seq = ++state.listSeq;
    if (reset || state.items.length === 0) renderList();

    const params = new URLSearchParams({
      box: VIEW_META[state.view].box,
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    if (state.q) params.set('q', state.q);
    if (state.unreadOnly && state.view === 'inbox') params.set('unread', '1');

    try {
      const data = await api(`/api/mails?${params.toString()}`);
      if (seq !== state.listSeq) return;
      const items = Array.isArray(data.items) ? data.items : [];
      state.items = reset || state.page === 1 ? items : state.items.concat(items);
      state.total = Number(data.total || 0);
      if (reset) {
        const node = $('#mail-list');
        if (node) node.scrollTop = 0;
      }
    } catch (error) {
      if (seq !== state.listSeq) return;
      if (error.status !== 401) toast(error.message, 'danger');
      state.items = [];
    } finally {
      if (seq === state.listSeq) {
        state.listLoading = false;
        renderList();
      }
    }
  }

  /* ==================== 阅读器 ==================== */

  function renderReader() {
    const reader = $('#reader');
    if (!reader) return;
    if (isPageView()) {
      reader.innerHTML =
        state.view === 'admin' ? renderAdminPage({ loading: true }) : renderSettingsPage();
      if (state.view === 'admin') loadAdmin();
      else bindSettingsPage();
      return;
    }
    if (state.mailLoading) {
      reader.innerHTML = `<div class="reader-bar"><span class="bar-title">加载中…</span></div>
        <div class="reader-scroll"><div class="reader-inner">
          <div class="skeleton" style="height:26px;width:65%;margin-bottom:16px"></div>
          <div class="skeleton" style="height:44px;width:100%"></div>
          <div class="skeleton" style="height:220px;width:100%;margin-top:22px"></div>
        </div></div>`;
      return;
    }
    if (!state.mail) {
      reader.innerHTML = emptyReaderHtml();
      return;
    }
    reader.innerHTML = mailReaderHtml(state.mail);
    afterReaderMount();
  }

  function emptyReaderHtml() {
    const admin = state.user && state.user.role === 'admin';
    return `<div class="reader-bar"><span class="bar-title">Cloud Mail</span></div>
      <div class="reader-scroll">
        <div class="reader-inner" style="display:grid;place-items:center;min-height:58vh">
          <div class="empty" style="padding:0">
            <div class="empty-icon" style="width:64px;height:64px;border-radius:20px">${icon('mail-open', 28)}</div>
            <strong style="font-size:15px">选择一封邮件开始阅读</strong>
            <p style="max-width:34ch">你的邮箱地址是 <strong style="color:var(--text-2)">${esc(state.user ? state.user.email : '')}</strong></p>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-primary" data-action="compose">${icon('pencil', 15)}写邮件</button>
              ${admin ? `<button class="btn" data-action="nav" data-view="admin">${icon('users', 15)}账号管理</button>` : ''}
            </div>
            <p style="margin-top:14px;font-size:12px">快捷键：<span class="code-inline">c</span> 写邮件 · <span class="code-inline">/</span> 搜索</p>
          </div>
        </div>
      </div>`;
  }

  function mailReaderHtml(mail) {
    const sent = Boolean(mail.sentAt) && !mail.receivedAt;
    const title = mail.subject || SUBJECT_FALLBACK;
    const bodyHtml =
      mail.bodyType === 'html'
        ? `<iframe class="mail-frame" id="mail-frame" title="邮件内容" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`
        : `<div class="mail-plain">${esc(mail.body || '（无正文）')}</div>`;

    const attachments = Array.isArray(mail.attachments) && mail.attachments.length
      ? `<div class="mail-attachments">${mail.attachments
          .map(
            (file) => `<span class="attachment">${icon('paperclip', 14)}${esc(file.filename || '附件')}
              <span class="size">${esc(fmtBytes(file.size))}</span></span>`,
          )
          .join('')}</div>`
      : '';

    const blockedImages =
      mail.bodyType === 'html' && !state.allowImages && /<img[^>]+src=["']?https?:/i.test(mail.body || '')
        ? `<div class="mail-notice">${icon('image', 15)}<span>为保护隐私，外部图片已被拦截</span>
             <button data-action="allow-images">显示图片</button></div>`
        : '';

    const sendFailed =
      mail.status === 'failed'
        ? `<div class="mail-notice" style="border-color:color-mix(in srgb, var(--danger) 35%, transparent);color:var(--danger)">
             ${icon('alert', 15)}<span>发送失败：${esc(mail.error || '未知原因')}</span></div>`
        : '';

    const isProxyMail = Boolean(
      state.user && mail.to && String(mail.to).toLowerCase() !== String(state.user.email || '').toLowerCase(),
    );
    const metaLeft = sent
      ? `<div class="who"><span class="name">发给 ${esc(displayName('', mail.to))}</span><span class="addr">&lt;${esc(mail.to)}&gt;</span></div>
         <div class="to">发件人：${esc(mail.from || '')}</div>`
      : `<div class="who"><span class="name">${esc(displayName(mail.fromName, mail.from))}</span><span class="addr">&lt;${esc(mail.from)}&gt;</span></div>
         <div class="to">收件人：${esc(mail.to)}${isProxyMail ? ' <span class="badge">代收</span>' : ''}${mail.realFrom && mail.realFrom !== mail.from ? ` · 实际发件人 ${esc(mail.realFrom)}` : ''}</div>`;

    const toolbar = sent
      ? `<button class="icon-btn reader-back" data-action="reader-close" aria-label="返回">${icon('back')}</button>
         <span class="bar-title">已发送</span>
         <span class="badge ${mail.status === 'failed' ? 'badge-danger' : 'badge-success'}">${mail.status === 'failed' ? '发送失败' : '已送达'}</span>
         <button class="icon-btn" data-action="mail-delete" title="删除发件记录">${icon('trash')}</button>`
      : `<button class="icon-btn reader-back" data-action="reader-close" aria-label="返回">${icon('back')}</button>
         <span class="bar-title">${esc(VIEW_META[state.view] ? VIEW_META[state.view].title : '邮件')}</span>
         ${state.view === 'trash' ? `<button class="icon-btn" data-action="mail-restore" title="移回收件箱">${icon('refresh')}</button>` : ''}
         ${state.view !== 'trash' ? `<button class="icon-btn" data-action="mail-reply" title="回复">${icon('reply')}</button>` : ''}
         <button class="icon-btn${mail.isStarred ? ' is-active' : ''}" data-action="mail-star" title="${mail.isStarred ? '取消星标' : '加星标'}"
           aria-pressed="${mail.isStarred ? 'true' : 'false'}">${icon('star')}</button>
         <button class="icon-btn" data-action="mail-unread" title="标记为未读">${icon('mail')}</button>
         <button class="icon-btn" data-action="mail-delete" title="${state.view === 'trash' ? '永久删除' : '移入垃圾箱'}">${icon('trash')}</button>`;

    return `<div class="reader-bar">${toolbar}</div>
      <div class="reader-scroll">
        <div class="reader-inner">
          <div class="mail-head">
            <h1>${esc(title)}</h1>
            <div class="mail-meta">
              ${sent ? `<span class="avatar" style="${avatarStyle(mail.to)}">${esc(initials('', mail.to))}</span>` : avatar(mail.fromName, mail.from)}
              <div class="mail-meta-text">${metaLeft}</div>
              <div class="mail-date">${esc(fmtFull(sent ? mail.sentAt : mail.receivedAt))}</div>
            </div>
          </div>
          ${blockedImages}
          <div class="mail-paper">${bodyHtml}</div>
          ${attachments}
          ${sendFailed}
        </div>
      </div>`;
  }

  function buildMailDocument(mail) {
    const allowImages = state.allowImages;
    const csp = [
      "default-src 'none'",
      `img-src ${allowImages ? 'https: http: data:' : 'data:'}`,
      "style-src 'unsafe-inline' https: http:",
      'font-src https: http: data:',
      'media-src https: http:',
      "form-action 'none'",
    ].join('; ');
    const css = `
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; background: #fff; }
      body {
        padding: 22px 24px 26px;
        color: #1b1e28;
        font: 14.5px/1.72 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
      img { max-width: 100%; height: auto; }
      a { color: #4f46e5; }
      table { max-width: 100%; }
      pre { white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
      blockquote { margin: 10px 0; padding: 2px 0 2px 14px; border-left: 3px solid #e6e8ef; color: #5b6172; }
      hr { border: 0; border-top: 1px solid #e6e8ef; margin: 18px 0; }
      * { max-width: 100%; }
    `;
    const head = `<meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
      <base target="_blank" rel="noopener noreferrer">
      <style>${css}</style>`;
    const raw = String(mail.body || '');
    // 有些邮件本身就是一整个 HTML 文档（带 doctype），直接嵌进 body 会出现嵌套 <html>
    if (/^\s*(<!doctype[^>]*>\s*)?<html[\s>]/i.test(raw.slice(0, 400))) {
      if (/<head[^>]*>/i.test(raw)) return raw.replace(/<head([^>]*)>/i, `<head$1>${head}`);
      if (/<html[^>]*>/i.test(raw)) return raw.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
      return `<!doctype html><html><head>${head}</head>${raw}`;
    }
    return `<!doctype html><html><head>${head}</head><body>${raw}</body></html>`;
  }

  function afterReaderMount() {
    const frame = $('#mail-frame');
    if (!frame || !state.mail) return;
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        const height = Math.max(200, doc.documentElement.scrollHeight + 4);
        frame.style.height = `${Math.min(height, 2000)}px`;
      } catch {
        frame.style.height = '520px';
      }
    });
    frame.srcdoc = buildMailDocument(state.mail);
    const scroll = $('.reader-scroll', $('#reader'));
    if (scroll) scroll.scrollTop = 0;
  }

  async function openMail(id, isSent) {
    state.selectedId = Number(id);
    state.mailLoading = true;
    state.mail = null;
    state.allowImages = false;
    highlightActive();
    renderReader();
    if (window.innerWidth <= 900 && shell()) shell().classList.add('reader-open');

    try {
      const path = isSent ? `/api/sent/${id}` : `/api/mails/${id}`;
      const data = await api(path);
      state.mail = data.mail;
      state.mailLoading = false;
      renderReader();

      if (!isSent && data.mail && !data.mail.isRead) {
        await api(`/api/mails/${id}`, { method: 'PATCH', body: { isRead: true } });
        const item = state.items.find((row) => row.id === Number(id));
        if (item) item.isRead = true;
        state.mail.isRead = true;
        state.counts.unread = Math.max(0, state.counts.unread - 1);
        renderList();
        updateRail();
      }
    } catch (error) {
      state.mailLoading = false;
      state.selectedId = null;
      renderReader();
      toast(error.message, 'danger');
    }
  }

  function closeReader() {
    state.selectedId = null;
    state.mail = null;
    if (shell()) shell().classList.remove('reader-open');
    renderReader();
    highlightActive();
  }

  /* ==================== 写邮件 ==================== */

  function openCompose(prefill = {}) {
    const from = state.user ? state.user.email : '';
    const canSendAs = Boolean(state.user && state.user.role === 'admin');
    const fromValue = prefixOfAddress(prefill.from || '');
    const fromField = !canSendAs
      ? ''
      : state.domain
        ? `<div class="field">
            <label for="c-from">发件人</label>
            <div class="input-group">
              <input id="c-from" class="input" name="from" type="text" inputmode="email" autocomplete="off"
                placeholder="${esc(prefixOfAddress(from))}" value="${esc(fromValue)}" />
              <span class="affix">@${esc(state.domain)}</span>
            </div>
            <span class="hint">只填前缀，域名自动补成 @${esc(state.domain)}；留空则用 ${esc(from)}</span>
          </div>`
        : `<div class="field">
            <label for="c-from">发件人</label>
            <input id="c-from" class="input" name="from" type="text" inputmode="email" autocomplete="off"
              placeholder="${esc(from)}" value="${esc(prefill.from || '')}" />
            <span class="hint">管理员可代其他地址发信；留空则使用 ${esc(from)}</span>
          </div>`;
    openModal({
      title: prefill.reply ? '回复邮件' : '写邮件',
      size: 'wide',
      body: `
        <form id="compose-form" style="display:flex;flex-direction:column;gap:14px">
          ${fromField}
          <div class="field">
            <label for="c-to">收件人</label>
            <input id="c-to" class="input" name="to" type="email" placeholder="someone@example.com"
              value="${esc(prefill.to || '')}" required />
          </div>
          <div class="field">
            <label for="c-subject">主题</label>
            <input id="c-subject" class="input" name="subject" placeholder="主题" value="${esc(prefill.subject || '')}" />
          </div>
          <div class="field">
            <label for="c-body">正文</label>
            <textarea id="c-body" class="textarea" name="body" placeholder="写点什么…" style="min-height:200px">${esc(prefill.body || '')}</textarea>
            <span class="hint">${canSendAs
              ? '发信域名需已在 Cloudflare Email Routing 中启用；代发地址也需是可投递的域名。'
              : `发件人固定为 ${esc(from)}，发信域名需已在 Cloudflare Email Routing 中启用。`}</span>
          </div>
        </form>`,
      footer: `
        <span class="hint" style="font-size:12px;color:var(--muted)">Ctrl / ⌘ + Enter 发送</span>
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-action="modal-close">取消</button>
        <button class="btn btn-primary" type="submit" form="compose-form" id="compose-send">${icon('send', 15)}发送</button>`,
      onMount(node) {
        const form = $('#compose-form', node);
        const bodyField = $('#c-body', node);
        if (bodyField) bodyField.focus();
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = $('#compose-send', node);
          const to = fv(form, 'to').trim();
          const subject = fv(form, 'subject').trim();
          const body = fv(form, 'body');
          const sender = canSendAs ? addressValueOf(fv(form, 'from')) : '';
          if (!to) return toast('请填写收件人', 'danger');
          if (!body.trim()) return toast('邮件正文不能为空', 'danger');
          button.disabled = true;
          const original = button.innerHTML;
          button.innerHTML = '<span class="spinner"></span>发送中…';
          try {
            const payload = { to, subject, body };
            if (sender) payload.from = sender;
            await api('/api/mails/send', { method: 'POST', body: payload });
            closeModal();
            toast(`已发送给 ${to}`, 'success');
            if (state.view === 'sent') loadList({ reset: true });
            refreshCounts();
          } catch (error) {
            button.disabled = false;
            button.innerHTML = original;
            toast(error.message, 'danger');
          }
        });
        form.addEventListener('keydown', (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            form.requestSubmit();
          }
        });
      },
    });
  }

  /** 纯文本化，用于回复时引用原文。 */
  function plainTextOf(mail) {
    const raw = String(mail.body || '');
    if (mail.bodyType !== 'html') return raw;
    return raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function replyToMail() {
    const mail = state.mail;
    if (!mail || mail.sentAt) return;
    const subject = /^re:/i.test(mail.subject || '') ? mail.subject : `Re: ${mail.subject || SUBJECT_FALLBACK}`;
    const quote = plainTextOf(mail)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const body = `\n\n在 ${fmtFull(mail.receivedAt)}，${displayName(mail.fromName, mail.from)} 写道：\n${quote}`;
    // 管理员默认用「这封信是发给谁」的地址回，保持身份一致
    const from = state.user && state.user.role === 'admin' ? mail.to || '' : '';
    openCompose({ to: mail.from, subject, body, from, reply: true });
  }

  /* ==================== 设置页 ==================== */

  function renderSettingsPage() {
    const user = state.user || {};
    const themeOptions = [
      ['auto', 'system', '跟随系统'],
      ['light', 'sun', '浅色'],
      ['dark', 'moon', '深色'],
    ];
    return `<div class="reader-bar">
        <button class="icon-btn reader-back" data-action="nav" data-view="inbox" aria-label="返回">${icon('back')}</button>
        <span class="bar-title">设置</span>
      </div>
      <div class="page-scroll">
        <div class="page-inner">
          <div>
            <h1 class="page-title">设置</h1>
            <p class="page-sub" style="margin-top:6px">管理你的账号、密码与界面偏好。</p>
          </div>

          <section class="card">
            <div class="card-head">
              <div>
                <h3>个人资料</h3>
                <p>显示名称会出现在发件人信息中</p>
              </div>
              ${avatar(user.name, user.email, 'avatar-lg')}
            </div>
            <div class="card-body">
              <form data-form="profile" class="form-grid">
                <div class="field">
                  <label for="p-name">显示名称</label>
                  <input id="p-name" class="input" name="name" value="${esc(user.name || '')}" maxlength="60" />
                </div>
                <div class="field">
                  <label for="p-email">邮箱地址</label>
                  <input id="p-email" class="input" value="${esc(user.email || '')}" disabled />
                  <span class="hint">邮箱地址不可修改，如需更换请让管理员新建账号</span>
                </div>
                <div class="form-actions" style="grid-column:1/-1">
                  <button class="btn btn-primary" type="submit">保存资料</button>
                </div>
              </form>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <h3>登录密码</h3>
                <p>修改后其他设备上的登录状态会失效</p>
              </div>
              ${icon('key', 18)}
            </div>
            <div class="card-body">
              <form data-form="password" class="form-grid">
                <div class="field">
                  <label for="p-current">当前密码</label>
                  <input id="p-current" class="input" name="current" type="password" autocomplete="current-password" required />
                </div>
                <div class="field">
                  <label for="p-next">新密码</label>
                  <input id="p-next" class="input" name="next" type="password" autocomplete="new-password" placeholder="至少 8 位" required />
                </div>
                <div class="form-actions" style="grid-column:1/-1">
                  <button class="btn btn-primary" type="submit">更新密码</button>
                </div>
              </form>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><div><h3>外观</h3><p>选择界面配色</p></div>${icon('sun', 18)}</div>
            <div class="card-body">
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${themeOptions
                  .map(
                    ([value, iconName, label]) => `<button class="btn${state.theme === value ? ' btn-primary' : ''}"
                      data-action="set-theme" data-theme="${value}">${icon(iconName, 15)}${label}</button>`,
                  )
                  .join('')}
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><div><h3>邮箱信息</h3><p>当前 Worker 的运行配置</p></div>${icon('shield', 18)}</div>
            <div class="card-body tight">
              <div class="list-rows">
                ${infoRow('邮箱地址', user.email || '—')}
                ${infoRow('收件域名', state.domain ? `@${state.domain}（自动识别）` : '未识别 · 可设置 MAIL_DOMAIN')}
                ${infoRow('账号角色', user.role === 'admin' ? '管理员' : '普通成员')}
                ${infoRow('邮件保留', state.mailRetention > 0
                  ? `全站最多 ${state.mailRetention} 封，超出后清理最旧的`
                  : '不限（全站永久保留）')}
                ${infoRow('垃圾箱清理', `${state.trashTtlDays} 天后自动删除`)}
                ${infoRow('上次登录', user.lastLoginAt ? fmtFull(user.lastLoginAt) : '首次登录')}
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div><h3>邮件接口密钥</h3><p>供脚本 / 第三方系统直接调用收发接口</p></div>
              <button class="icon-btn" data-action="key-new" title="新建密钥">${icon('plus')}</button>
            </div>
            <div class="card-body tight" id="key-body">
              <div class="row-item"><span class="skeleton sk-line" style="width:60%"></span></div>
              <div class="row-item"><span class="skeleton sk-line" style="width:40%"></span></div>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><div><h3>会话</h3><p>退出后需要重新输入密码</p></div></div>
            <div class="card-body" style="flex-direction:row">
              <button class="btn btn-danger" data-action="logout">${icon('logout', 15)}退出登录</button>
            </div>
          </section>
        </div>
      </div>`;
  }

  function infoRow(label, value) {
    return `<div class="row-item">
      <div class="row-main"><div class="row-desc">${esc(label)}</div></div>
      <div style="font-size:13px;color:var(--text-2);text-align:right;word-break:break-all">${esc(value)}</div>
    </div>`;
  }

  function bindSettingsPage() {
    loadApiKeys();
    const form = $('[data-form="profile"]');
    if (!form) return;
    const pwdForm = $('[data-form="password"]');
    if (pwdForm) {
      pwdForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = $('button[type=submit]', pwdForm);
        button.disabled = true;
        try {
          await api('/api/me/password', {
            method: 'POST',
            body: { currentPassword: fv(pwdForm, 'current'), newPassword: fv(pwdForm, 'next') },
          });
          pwdForm.reset();
          toast('密码已更新', 'success');
        } catch (error) {
          toast(error.message, 'danger');
        } finally {
          button.disabled = false;
        }
      });
    }
  }

  /* ==================== 接口密钥 ==================== */

  async function loadApiKeys() {
    const node = $('#key-body');
    if (!node) return;
    try {
      const data = await api('/api/keys');
      state.keys = Array.isArray(data.keys) ? data.keys : [];
      node.innerHTML = keysHtml(state.keys);
    } catch (error) {
      node.innerHTML = `<div class="row-item"><div class="row-main"><div class="row-desc">${esc(error.message)}</div></div></div>`;
    }
  }

  function keysHtml(keys) {
    const rows = keys.length
      ? keys
          .map(
            (key) => `<div class="row-item">
          <div class="row-main">
            <div class="row-title">${esc(key.name || '未命名密钥')}</div>
            <div class="row-desc"><span class="code-inline">${esc(key.masked)}</span> · 创建于 ${esc(fmtDate(key.createdAt))}${key.lastUsedAt ? ` · 最近使用 ${esc(fmtDate(key.lastUsedAt))}` : ' · 尚未使用'}</div>
          </div>
          <button class="btn btn-ghost" data-action="key-revoke" data-id="${key.id}">撤销</button>
        </div>`,
          )
          .join('')
      : `<div class="row-item">
          <div class="row-main">
            <div class="row-title">还没有密钥</div>
            <div class="row-desc">点击右上角 + 新建，即可用 x-api-key 头调用 /api/* 收发邮件</div>
          </div>
        </div>`;
    return `${rows}
      <div class="row-item" style="display:block">
        <div class="row-desc" style="margin-bottom:8px">调用示例</div>
        <pre class="code-block">curl -H "x-api-key: cm_你的密钥" \\
  https://你的域名/api/mails?box=inbox

curl -X POST -H "x-api-key: cm_你的密钥" \\
  -H "content-type: application/json" \\
  -d '{"to":"friend@example.com","subject":"你好","body":"正文"}' \\
  https://你的域名/api/mails/send</pre>
      </div>`;
  }

  function openKeyForm() {
    openModal({
      title: '新建接口密钥',
      body: `<form id="key-form" class="form-grid">
          <div class="field" style="grid-column:1/-1">
            <label for="k-name">名称</label>
            <input id="k-name" class="input" name="name" placeholder="例如：监控告警机器人" maxlength="60" />
            <span class="hint">名称只用于区分用途，密钥可随时撤销</span>
          </div>
        </form>`,
      footer: `<div class="spacer"></div>
        <button class="btn btn-ghost" data-action="modal-close">取消</button>
        <button class="btn btn-primary" type="submit" form="key-form" id="key-submit">${icon('key', 15)}创建</button>`,
      onMount(node) {
        const form = $('#key-form', node);
        const input = $('#k-name', node);
        if (input) input.focus();
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = $('#key-submit', node);
          button.disabled = true;
          try {
            const data = await api('/api/keys', { method: 'POST', body: { name: fv(form, 'name').trim() } });
            showNewKey(data.key, data.masked);
            loadApiKeys();
          } catch (error) {
            toast(error.message, 'danger');
            button.disabled = false;
          }
        });
      },
    });
  }

  function showNewKey(key, masked) {
    openModal({
      title: '密钥已创建',
      body: `<p class="page-sub" style="margin:0 0 12px">请立即复制保存。关闭后只能看到缩略形式 <span class="code-inline">${esc(masked)}</span>。</p>
        <pre class="code-block" id="new-key">${esc(key)}</pre>`,
      footer: `<div class="spacer"></div>
        <button class="btn" data-action="key-copy" data-key="${esc(key)}">${icon('key', 15)}复制密钥</button>
        <button class="btn btn-primary" data-action="modal-close">完成</button>`,
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'success');
      return;
    } catch {
      /* 退回到选中复制 */
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('已复制到剪贴板', 'success');
    } catch {
      toast('复制失败，请手动选择文本', 'danger');
    }
  }

  async function revokeKey(id) {
    const confirmed = await confirmDialog({
      title: '撤销密钥',
      message: '撤销会把这条密钥从服务器彻底删除：用它的脚本立即失效，记录也不可恢复。',
      confirmText: '撤销并删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/keys/${id}/revoke`, { method: 'POST' });
      toast('密钥已删除', 'success');
      loadApiKeys();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  /* ==================== 账号管理 ==================== */

  function renderAdminPage({ loading = false } = {}) {
    return `<div class="reader-bar">
        <button class="icon-btn reader-back" data-action="nav" data-view="inbox" aria-label="返回">${icon('back')}</button>
        <span class="bar-title">账号管理</span>
        <button class="btn btn-primary" data-action="user-new" style="height:32px;font-size:12.5px">${icon('plus', 14)}新建账号</button>
      </div>
      <div class="page-scroll">
        <div class="page-inner">
          <div>
            <h1 class="page-title">账号管理</h1>
            <p class="page-sub" style="margin-top:6px">为团队成员创建普通账号：每个账号拥有独立邮箱与收件箱。</p>
          </div>
          <div class="stat-grid" id="admin-stats">
            ${['账号', '邮件', '已发送', '未读'].map((label) => `<div class="stat"><div class="label">${label}</div><div class="value"><span class="skeleton" style="display:inline-block;width:34px;height:20px"></span></div></div>`).join('')}
          </div>
          <section class="card">
            <div class="card-head">
              <div><h3>成员账号</h3><p>普通成员只能访问自己的邮箱</p></div>
              <button class="icon-btn" data-action="admin-refresh" title="刷新">${icon('refresh')}</button>
            </div>
            <div class="card-body tight" id="admin-users">
              ${loading ? '<div class="empty"><span class="spinner"></span></div>' : ''}
            </div>
          </section>
          <section class="card">
            <div class="card-head">
              <div><h3>收信诊断</h3><p>查看无主邮件去向、域名来源与账号归属</p></div>
              <button class="icon-btn" data-action="diag-run" title="运行检查">${icon('shield')}</button>
            </div>
            <div class="card-body tight" id="diag-body">
              <div class="row-item">
                <div class="row-main">
                  <div class="row-title">点右上角运行检查</div>
                  <div class="row-desc">会列出总邮件数、滞留的无主邮件、各账号收件数与收件域名来源</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>`;
  }

  async function loadAdmin() {
    try {
      const [usersData, overview] = await Promise.all([api('/api/users'), api('/api/admin/overview')]);
      const stats = overview.stats || {};
      const statsNode = $('#admin-stats');
      if (statsNode) {
        const entries = [
          ['账号', stats.users || 0],
          ['邮件', stats.mails || 0],
          ['已发送', stats.sent || 0],
          ['未读', stats.unread || 0],
        ];
        statsNode.innerHTML = entries
          .map(([label, value]) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`)
          .join('');
      }
      const node = $('#admin-users');
      if (node) node.innerHTML = usersTableHtml(usersData.users || []);
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function runDiagnostics() {
    const node = $('#diag-body');
    if (!node) return;
    node.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      const data = await api('/api/diagnostics');
      node.innerHTML = diagnosticsHtml(data);
    } catch (error) {
      node.innerHTML = `<div class="row-item"><div class="row-main"><div class="row-desc">${esc(error.message)}</div></div></div>`;
    }
  }

  function diagnosticsHtml(data) {
    const stats = data.stats || {};
    const sourceLabel = { env: 'MAIL_DOMAIN 环境变量', mail: '历史邮件学到的', unknown: '未识别' };
    const row = (title, desc) => `<div class="row-item">
        <div class="row-main"><div class="row-title">${title}</div><div class="row-desc">${desc}</div></div>
      </div>`;
    const users = (data.users || [])
      .map((u) => `${esc(u.email)}${u.role === 'admin' ? '（管理员）' : ''}${u.status === 'disabled' ? '（已停用）' : ''} · ${u.mailCount} 封`)
      .join('<br>');
    const stranded = (data.stranded || []).length
      ? data.stranded
          .map((m) => `#${m.id} · ${esc(m.subject || '(无主题)')} → ${esc(m.receiver || '(未知地址)')}`)
          .join('<br>')
      : '没有滞留邮件';
    const orphanAction =
      Number(stats.orphans || 0) > 0
        ? `<div class="row-item" style="display:block">
             <button class="btn btn-primary" data-action="diag-adopt">把这 ${stats.orphans} 封无主邮件归到管理员</button>
           </div>`
        : '';
    return [
      row('收件域名', `${data.domain ? esc('@' + data.domain) : '未识别'} · 来源：${esc(sourceLabel[data.domainSource] || data.domainSource || '未知')}`),
      row('管理员账号', data.admin ? esc(data.admin.email) : '还没有可用管理员'),
      row('邮件统计', `共 ${stats.emails || 0} 封 · 无主 ${stats.orphans || 0} 封 · 未读 ${stats.unread || 0} 封 · 已发送 ${stats.sends || 0} 条 · 接口密钥 ${stats.apiKeys || 0} 个`),
      row('各账号收件', users || '还没有账号'),
      row('滞留（无主）邮件', stranded),
      orphanAction,
      row(
        '排查提示',
        (data.hints || []).map((h, i) => `${i + 1}. ${esc(h)}`).join('<br>'),
      ),
    ].join('');
  }

  async function adoptOrphans() {
    try {
      const data = await api('/api/diagnostics/adopt', { method: 'POST' });
      toast(data.moved ? `已把 ${data.moved} 封无主邮件归到 ${data.owner}` : '没有滞留邮件需要处理', 'success');
      runDiagnostics();
      loadList({ reset: true });
      refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  function usersTableHtml(users) {
    if (!users.length) {
      return '<div class="empty"><strong>还没有账号</strong><p>点击右上角新建第一个账号</p></div>';
    }
    const me = state.user || {};
    const rows = users
      .map((user) => {
        const isMe = user.id === me.id;
        const roleBadge = user.role === 'admin' ? '<span class="badge badge-accent">管理员</span>' : '<span class="badge">普通成员</span>';
        const statusBadge = user.status === 'disabled' ? '<span class="badge badge-danger">已停用</span>' : '';
        const actions = [
          `<button class="icon-btn" data-action="user-reset" data-id="${user.id}" title="重置密码">${icon('key', 16)}</button>`,
          `<button class="icon-btn" data-action="user-toggle" data-id="${user.id}" data-status="${user.status}"
             title="${user.status === 'disabled' ? '启用账号' : '停用账号'}" ${isMe ? 'disabled style="opacity:.35;cursor:not-allowed"' : ''}>${icon('shield', 16)}</button>`,
          `<button class="icon-btn ${isMe ? '' : 'btn-danger'}" data-action="user-delete" data-id="${user.id}" title="删除账号"
             ${isMe ? 'disabled style="opacity:.35;cursor:not-allowed"' : ''}>${icon('trash', 16)}</button>`,
        ].join('');
        return `<tr>
          <td>
            <div class="cell-user">
              ${avatar(user.name, user.email)}
              <div style="min-width:0">
                <div class="u-name">${esc(user.name || user.email.split('@')[0])}${isMe ? ' <span class="badge" style="height:18px">我</span>' : ''}</div>
                <div class="u-mail">${esc(user.email)}</div>
              </div>
            </div>
          </td>
          <td>${roleBadge} ${statusBadge}</td>
          <td class="mono">${user.mailCount || 0}</td>
          <td class="mono">${user.sentCount || 0}</td>
          <td class="mono" style="white-space:nowrap">${esc(user.lastLoginAt ? fmtDate(user.lastLoginAt) : '—')}</td>
          <td><div class="row-actions">${actions}</div></td>
        </tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th>成员</th><th>角色</th><th>邮件</th><th>已发送</th><th>最近登录</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function openUserForm(user) {
    const editing = Boolean(user);
    openModal({
      title: editing ? '编辑账号' : '新建账号',
      body: `
        <form id="user-form" style="display:flex;flex-direction:column;gap:14px">
          ${
            editing
              ? `<div class="field">
                  <label for="u-email">邮箱地址</label>
                  <input id="u-email" class="input" value="${esc(user.email)}" disabled />
                </div>`
              : addressInput({
                  id: 'u-email',
                  name: 'email',
                  label: '邮箱地址',
                  placeholder: 'member',
                  hint: domainHint('需在 Cloudflare Email Routing 中启用该地址才能收信'),
                })
          }
          <div class="field">
            <label for="u-name">显示名称</label>
            <input id="u-name" class="input" name="name" maxlength="60" value="${esc(user ? user.name : '')}"
              placeholder="留空则取邮箱前缀" />
          </div>
          ${
            editing
              ? ''
              : `<div class="field">
                  <label for="u-password">初始密码</label>
                  <input id="u-password" class="input" name="password" type="password" autocomplete="new-password" placeholder="至少 8 位" required />
                </div>`
          }
          <div class="form-grid">
            <div class="field">
              <label for="u-role">角色</label>
              <select id="u-role" class="select" name="role">
                <option value="user"${user && user.role === 'user' ? ' selected' : ''}>普通成员</option>
                <option value="admin"${user && user.role === 'admin' ? ' selected' : ''}>管理员</option>
              </select>
            </div>
            <div class="field">
              <label for="u-status">状态</label>
              <select id="u-status" class="select" name="status">
                <option value="active"${user && user.status === 'active' ? ' selected' : ''}>正常</option>
                <option value="disabled"${user && user.status === 'disabled' ? ' selected' : ''}>停用</option>
              </select>
            </div>
          </div>
        </form>`,
      footer: `
        <div class="spacer"></div>
        <button class="btn btn-ghost" data-action="modal-close">取消</button>
        <button class="btn btn-primary" type="submit" form="user-form" id="user-save">${editing ? '保存' : '创建账号'}</button>`,
      onMount(node) {
        const form = $('#user-form', node);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = $('#user-save', node);
          button.disabled = true;
          try {
            if (editing) {
              await api(`/api/users/${user.id}`, {
                method: 'PATCH',
                body: { name: fv(form, 'name'), role: fv(form, 'role'), status: fv(form, 'status') },
              });
              toast('账号已更新', 'success');
            } else {
              await api('/api/users', {
                method: 'POST',
                body: {
                  email: fv(form, 'email').trim(),
                  name: fv(form, 'name').trim(),
                  password: fv(form, 'password'),
                  role: fv(form, 'role'),
                  status: fv(form, 'status'),
                },
              });
              toast('账号已创建', 'success');
            }
            closeModal();
            loadAdmin();
          } catch (error) {
            button.disabled = false;
            toast(error.message, 'danger');
          }
        });
      },
    });
  }

  function openResetPassword(user) {
    openModal({
      title: '重置密码',
      size: 'narrow',
      body: `<form id="reset-form" style="display:flex;flex-direction:column;gap:14px">
          <p style="margin:0;font-size:13px;color:var(--text-2);line-height:1.65">
            为 <strong>${esc(user.name || user.email)}</strong> 设置新密码，该账号在所有设备上的登录状态会立即失效。
          </p>
          <div class="field">
            <label for="r-password">新密码</label>
            <input id="r-password" class="input" name="password" type="password" autocomplete="new-password" placeholder="至少 8 位" required />
          </div>
        </form>`,
      footer: `<div class="spacer"></div>
        <button class="btn btn-ghost" data-action="modal-close">取消</button>
        <button class="btn btn-primary" type="submit" form="reset-form" id="reset-save">重置密码</button>`,
      onMount(node) {
        const form = $('#reset-form', node);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = $('#reset-save', node);
          button.disabled = true;
          try {
            await api(`/api/users/${user.id}/password`, { method: 'POST', body: { password: fv(form, 'password') } });
            closeModal();
            toast('密码已重置', 'success');
          } catch (error) {
            button.disabled = false;
            toast(error.message, 'danger');
          }
        });
      },
    });
  }

  async function findUser(id) {
    try {
      const data = await api('/api/users');
      return (data.users || []).find((user) => user.id === Number(id)) || null;
    } catch {
      return null;
    }
  }

  /* ==================== 账户 / 会话 ==================== */

  function openUserMenu() {
    const user = state.user || {};
    openModal({
      title: '账户',
      size: 'narrow',
      body: `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:6px 0 4px">
          ${avatar(user.name, user.email, 'avatar-lg')}
          <div style="text-align:center">
            <div style="font-size:15px;font-weight:650">${esc(user.name || user.email)}</div>
            <div style="font-size:12.5px;color:var(--muted);margin-top:2px">${esc(user.email)}</div>
            <div style="margin-top:8px">${user.role === 'admin' ? '<span class="badge badge-accent">管理员</span>' : '<span class="badge">普通成员</span>'}</div>
          </div>
        </div>`,
      footer: `<button class="btn btn-ghost" data-action="nav" data-view="settings">${icon('settings', 15)}设置</button>
        <div class="spacer"></div>
        <button class="btn btn-danger" data-action="logout">${icon('logout', 15)}退出登录</button>`,
    });
  }

  async function signOut(silent = false) {
    if (state.token && !silent) {
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } catch {
        /* 忽略 */
      }
    }
    state.token = '';
    state.user = null;
    state.mail = null;
    state.selectedId = null;
    state.items = [];
    localStorage.removeItem(LS_TOKEN);
    closeModal();
    await showAuth();
  }

  function handleSessionExpired() {
    if (!state.token) return;
    state.token = '';
    localStorage.removeItem(LS_TOKEN);
    toast('登录状态已失效，请重新登录', 'danger');
    showAuth();
  }

  /* ==================== 数据刷新 ==================== */

  async function refreshCounts() {
    try {
      const data = await api('/api/me');
      state.user = data.user || state.user;
      state.counts = { ...state.counts, ...(data.counts || {}) };
      state.domain = data.domain || state.domain;
      state.mailbox = data.mailbox || state.mailbox;
      state.canSendAs = Boolean(data.canSendAs);
      state.trashTtlDays = Number(data.trashTtlDays) || state.trashTtlDays;
      state.mailRetention = Number(data.mailRetention) || 0;
      updateRail();
    } catch {
      /* 静默 */
    }
  }

  async function switchView(view) {
    if (!VIEW_META[view]) return;
    closeModal();
    state.view = view;
    state.q = '';
    state.unreadOnly = false;
    state.selectedId = null;
    state.mail = null;
    state.allowImages = false;
    renderShell();
    if (isPageView()) {
      if (window.innerWidth <= 900 && shell()) shell().classList.add('reader-open');
      if (view === 'settings') refreshCounts();
    } else {
      loadList({ reset: true });
    }
  }

  /* ==================== 事件 ==================== */

  document.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    closeContextMenu();

    switch (action) {
      case 'nav':
        await switchView(trigger.dataset.view);
        break;
      case 'refresh':
        await loadList({ reset: true });
        await refreshCounts();
        break;
      case 'compose':
        openCompose();
        break;
      case 'open-mail':
        await openMail(trigger.dataset.id, trigger.dataset.sent === '1');
        break;
      case 'reader-close':
        closeReader();
        break;
      case 'mail-star':
        await toggleStar();
        break;
      case 'mail-unread':
        await markUnread();
        break;
      case 'mail-delete':
        await deleteMail();
        break;
      case 'allow-images':
        state.allowImages = true;
        renderReader();
        break;
      case 'empty-trash':
        await emptyTrash();
        break;
      case 'mail-reply':
        replyToMail();
        break;
      case 'mail-restore':
        if (state.mail) await restoreMail(state.mail.id);
        break;
      case 'ctx-open':
        await openMail(trigger.dataset.id, trigger.dataset.sent === '1');
        break;
      case 'ctx-reply':
        await openMail(trigger.dataset.id, false);
        replyToMail();
        break;
      case 'ctx-read':
      case 'ctx-unread':
        await patchListItem(Number(trigger.dataset.id), { isRead: action === 'ctx-read' });
        break;
      case 'ctx-star': {
        const row = state.items.find((entry) => entry.id === Number(trigger.dataset.id));
        await patchListItem(Number(trigger.dataset.id), { isStarred: !(row && row.isStarred) }, {
          onOk: () => toast(row && row.isStarred ? '已取消星标' : '已加星标', 'success'),
        });
        break;
      }
      case 'ctx-delete':
        await deleteListItem(Number(trigger.dataset.id));
        break;
      case 'ctx-restore':
        await restoreMail(Number(trigger.dataset.id));
        break;
      case 'ctx-delete-forever':
        await deleteListItem(Number(trigger.dataset.id), true);
        break;
      case 'ctx-empty-trash':
        await emptyTrash();
        break;
      case 'ctx-again': {
        const row = state.items.find((entry) => entry.id === Number(trigger.dataset.id));
        openCompose({ to: row ? row.to : '', subject: row ? `Re: ${row.subject || SUBJECT_FALLBACK}` : '' });
        break;
      }
      case 'ctx-sent-delete':
        await deleteSent(Number(trigger.dataset.id));
        break;
      case 'chip-all':
        if (!state.unreadOnly) break;
        state.unreadOnly = false;
        $$('.chip').forEach((chip) => chip.classList.remove('is-active'));
        trigger.classList.add('is-active');
        await loadList({ reset: true });
        break;
      case 'chip-unread':
        if (state.unreadOnly) break;
        state.unreadOnly = true;
        $$('.chip').forEach((chip) => chip.classList.remove('is-active'));
        trigger.classList.add('is-active');
        await loadList({ reset: true });
        break;
      case 'clear-search':
        state.q = '';
        renderShell();
        await loadList({ reset: true });
        break;
      case 'load-more':
        state.page += 1;
        await loadList();
        break;
      case 'toggle-theme':
        applyTheme(trigger.dataset.nextTheme || 'auto');
        break;
      case 'set-theme':
        applyTheme(trigger.dataset.theme);
        $$('[data-action="set-theme"]').forEach((btn) => {
          btn.classList.toggle('btn-primary', btn.dataset.theme === state.theme);
        });
        break;
      case 'user-menu':
        openUserMenu();
        break;
      case 'logout':
        await signOut();
        break;
      case 'modal-close':
        closeModal();
        break;
      case 'modal-backdrop':
        if (event.target === trigger) closeModal();
        break;
      case 'user-new':
        openUserForm(null);
        break;
      case 'user-edit': {
        const user = await findUser(trigger.dataset.id);
        if (user) openUserForm(user);
        break;
      }
      case 'user-reset': {
        const user = await findUser(trigger.dataset.id);
        if (user) openResetPassword(user);
        break;
      }
      case 'user-toggle': {
        const user = await findUser(trigger.dataset.id);
        if (!user) break;
        const nextStatus = user.status === 'disabled' ? 'active' : 'disabled';
        try {
          await api(`/api/users/${user.id}`, { method: 'PATCH', body: { status: nextStatus } });
          toast(nextStatus === 'active' ? '账号已启用' : '账号已停用', 'success');
          loadAdmin();
        } catch (error) {
          toast(error.message, 'danger');
        }
        break;
      }
      case 'user-delete': {
        const user = await findUser(trigger.dataset.id);
        if (!user) break;
        const confirmed = await confirmDialog({
          title: '删除账号',
          message: `确定删除 ${user.email} 吗？该账号的邮件与会话将一并清除，且无法恢复。`,
          confirmText: '删除',
          danger: true,
        });
        if (!confirmed) break;
        try {
          await api(`/api/users/${user.id}`, { method: 'DELETE' });
          toast('账号已删除', 'success');
          loadAdmin();
        } catch (error) {
          toast(error.message, 'danger');
        }
        break;
      }
      case 'admin-refresh':
        loadAdmin();
        break;
      case 'diag-run':
        runDiagnostics();
        break;
      case 'diag-adopt':
        adoptOrphans();
        break;
      case 'key-new':
        openKeyForm();
        break;
      case 'key-copy':
        await copyText(trigger.dataset.key || '');
        break;
      case 'key-revoke':
        await revokeKey(Number(trigger.dataset.id));
        break;
      default:
        break;
    }
  });

  document.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.mail-item');
    if (!row) {
      closeContextMenu();
      return;
    }
    event.preventDefault();
    const item = state.items.find((entry) => entry.id === Number(row.dataset.id));
    if (!item) return;
    openContextMenu(item, event.clientX, event.clientY);
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#ctx-menu')) closeContextMenu();
  }, true);

  document.addEventListener('scroll', () => closeContextMenu(), true);
  window.addEventListener('resize', () => closeContextMenu());

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const kind = form.dataset.form;
    if (!kind) return;
    event.preventDefault();
    if (kind === 'login') submitLogin(form);
    else if (kind === 'setup') submitSetup(form);
    else if (kind === 'profile') {
      const button = $('button[type=submit]', form);
      button.disabled = true;
      api('/api/me', { method: 'PATCH', body: { name: fv(form, 'name').trim() } })
        .then((data) => {
          state.user = data.user;
          toast('资料已保存', 'success');
          renderReader();
        })
        .catch((error) => toast(error.message, 'danger'))
        .finally(() => {
          button.disabled = false;
        });
    }
  });

  let searchTimer = 0;
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'search') return;
    const value = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (state.q === value.trim()) return;
      state.q = value.trim();
      loadList({ reset: true });
      const wrap = $('.search-wrap');
      if (wrap) {
        const existing = $('.search-clear', wrap);
        if (state.q && !existing) {
          wrap.insertAdjacentHTML('beforeend', `<button class="search-clear" data-action="clear-search" aria-label="清除">${icon('x', 13)}</button>`);
        } else if (!state.q && existing) {
          existing.remove();
        }
      }
    }, 280);
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement ? document.activeElement.tagName : '');
    if (event.key === 'Escape') {
      if ($('#ctx-menu')) {
        closeContextMenu();
        event.preventDefault();
      } else if (state.modal) {
        closeModal();
        event.preventDefault();
      } else if (state.selectedId && window.innerWidth <= 900) {
        closeReader();
      }
      return;
    }
    if (typing || state.modal || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'c') {
      event.preventDefault();
      openCompose();
    } else if (event.key === '/') {
      event.preventDefault();
      const input = $('#search');
      if (input) input.focus();
    }
  });

  /* ==================== 邮件操作 ==================== */

  async function toggleStar() {
    if (!state.mail || state.mail.sentAt) return;
    const next = !state.mail.isStarred;
    try {
      await api(`/api/mails/${state.mail.id}`, { method: 'PATCH', body: { isStarred: next } });
      state.mail.isStarred = next;
      const item = state.items.find((row) => row.id === state.mail.id);
      if (item) item.isStarred = next;
      if (state.view === 'starred' && !next) {
        await loadList({ reset: true });
      } else {
        renderList();
      }
      renderReader();
      state.counts.starred = Math.max(0, state.counts.starred + (next ? 1 : -1));
      if (next) toast('已加星标', 'success');
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function markUnread() {
    if (!state.mail || state.mail.sentAt) return;
    try {
      await api(`/api/mails/${state.mail.id}`, { method: 'PATCH', body: { isRead: false } });
      const item = state.items.find((row) => row.id === state.mail.id);
      if (item) item.isRead = false;
      state.counts.unread += 1;
      updateRail();
      renderList();
      toast('已标记为未读');
      closeReader();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function deleteMail() {
    if (!state.mail) return;
    if (state.mail.sentAt) {
      await deleteSent(state.mail.id);
      return;
    }
    const permanent = state.view === 'trash';
    if (permanent) {
      const okToDelete = await confirmDialog({
        title: '永久删除',
        message: '该邮件将被永久删除，无法恢复。',
        confirmText: '永久删除',
        danger: true,
      });
      if (!okToDelete) return;
    }
    try {
      await api(`/api/mails/${state.mail.id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' });
      toast(permanent ? '邮件已永久删除' : '已移入垃圾箱', 'success');
      closeReader();
      await loadList({ reset: true });
      await refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function emptyTrash() {
    const confirmed = await confirmDialog({
      title: '清空垃圾箱',
      message: '垃圾箱中的所有邮件将被永久删除，无法恢复。',
      confirmText: '清空',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const data = await api('/api/mails/trash/empty', { method: 'POST' });
      toast(`已清空 ${data.removed || 0} 封邮件`, 'success');
      state.selectedId = null;
      state.mail = null;
      await loadList({ reset: true });
      renderReader();
      await refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  /* ==================== 右键菜单 ==================== */

  function closeContextMenu() {
    const node = $('#ctx-menu');
    if (node) node.remove();
  }

  function contextMenuEntries(item) {
    const sent = state.view === 'sent';
    const inTrash = state.view === 'trash';
    if (inTrash) {
      return [
        { action: 'ctx-open', label: '打开', icon: 'mail-open' },
        { action: 'ctx-restore', label: '移回收件箱', icon: 'refresh' },
        { action: 'ctx-delete-forever', label: '永久删除', icon: 'trash', danger: true },
        { action: 'ctx-empty-trash', label: '清空垃圾箱', icon: 'trash', danger: true },
      ];
    }
    if (sent) {
      return [
        { action: 'ctx-open', label: '查看内容', icon: 'mail-open' },
        { action: 'ctx-again', label: '再写一封', icon: 'pencil' },
        { action: 'ctx-sent-delete', label: '删除发件记录', icon: 'trash', danger: true },
      ];
    }
    return [
      { action: 'ctx-open', label: '打开', icon: 'mail-open' },
      { action: 'ctx-reply', label: '回复', icon: 'reply' },
      { action: item.isRead ? 'ctx-unread' : 'ctx-read', label: item.isRead ? '标记为未读' : '标记为已读', icon: 'mail' },
      { action: 'ctx-star', label: item.isStarred ? '取消星标' : '加星标', icon: 'star' },
      { action: 'ctx-delete', label: '移入垃圾箱', icon: 'trash', danger: true },
    ];
  }

  function openContextMenu(item, x, y) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = contextMenuEntries(item)
      .map(
        (entry) => `<button class="ctx-item${entry.danger ? ' is-danger' : ''}" role="menuitem"
          data-action="${entry.action}" data-id="${item.id}" data-sent="${state.view === 'sent' ? '1' : '0'}">
          ${icon(entry.icon, 15)}<span>${esc(entry.label)}</span>
        </button>`,
      )
      .join('');
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  async function restoreMail(id) {
    try {
      await api(`/api/mails/${id}`, { method: 'PATCH', body: { restore: true } });
      toast('已移回收件箱', 'success');
      if (state.selectedId === Number(id)) closeReader();
      await loadList({ reset: true });
      await refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function patchListItem(id, body, { onOk } = {}) {
    try {
      await api(`/api/mails/${id}`, { method: 'PATCH', body });
      if (onOk) onOk();
      await loadList({ reset: true });
      await refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function deleteSent(id) {
    const confirmed = await confirmDialog({
      title: '删除发件记录',
      message: '只会删掉这里的发件记录，已经发出去的邮件无法从对方邮箱撤回。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api(`/api/sent/${id}`, { method: 'DELETE' });
      toast('发件记录已删除', 'success');
      if (state.selectedId === Number(id)) closeReader();
      await loadList({ reset: true });
      await refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  async function deleteListItem(id, permanent = false) {
    if (permanent) {
      const okToDelete = await confirmDialog({
        title: '永久删除',
        message: '该邮件将被永久删除，无法恢复。',
        confirmText: '永久删除',
        danger: true,
      });
      if (!okToDelete) return;
    }
    try {
      await api(`/api/mails/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' });
      toast(permanent ? '邮件已永久删除' : '已移入垃圾箱', 'success');
      if (state.selectedId === Number(id)) closeReader();
      await loadList({ reset: true });
      await refreshCounts();
    } catch (error) {
      toast(error.message, 'danger');
    }
  }

  /* ==================== 启动 ==================== */

  function renderSplash() {
    app().innerHTML = `<div class="auth-screen">
      <div style="display:grid;place-items:center;gap:14px">
        <span class="brand-mark" style="width:48px;height:48px;border-radius:14px">${icon('mail', 26)}</span>
        <span class="spinner" style="width:20px;height:20px;color:var(--muted)"></span>
      </div>
    </div>`;
  }

  function renderFatal(message) {
    app().innerHTML = `<div class="auth-screen">
      <div class="auth-card" style="text-align:center">
        <div class="empty" style="padding:10px 0 0">
          <div class="empty-icon" style="background:var(--danger-soft);color:var(--danger)">${icon('alert', 24)}</div>
          <strong>无法连接到服务</strong>
          <p>${esc(message || '请检查 Worker 是否正常部署')}</p>
          <button class="btn" style="margin-top:6px" data-action="reload">重新加载</button>
        </div>
      </div>
    </div>`;
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="reload"]')) location.reload();
  });

  async function showAuth() {
    try {
      const status = await api('/api/setup', { auth: false });
      state.setup = {
        needsSetup: Boolean(status.needsSetup),
        userCount: status.userCount || 0,
        defaultAdmin: status.defaultAdmin || '',
      };
      state.domain = status.domain || state.domain;
    } catch (error) {
      renderFatal(error.message);
      return;
    }
    renderAuth();
  }

  async function bootApp(userHint) {
    try {
      const data = await api('/api/me');
      state.user = data.user || userHint || null;
      state.domain = data.domain || state.domain;
      state.mailbox = data.mailbox || '';
      state.canSendAs = Boolean(data.canSendAs);
      state.trashTtlDays = Number(data.trashTtlDays) || 30;
      state.mailRetention = Number(data.mailRetention) || 0;
      state.counts = { ...state.counts, ...(data.counts || {}) };
      state.view = 'inbox';
      state.q = '';
      state.page = 1;
      state.items = [];
      state.selectedId = null;
      state.mail = null;
      renderShell();
      updateRail();
      await loadList({ reset: true });
      if (window.innerWidth > 900) {
        // 桌面端自动打开第一封未读邮件
        const firstUnread = state.items.find((item) => !item.isRead);
        if (firstUnread) await openMail(firstUnread.id, false);
      }
    } catch (error) {
      if (error.status === 401) {
        await showAuth();
        return;
      }
      renderFatal(error.message);
    }
  }

  async function boot() {
    applyTheme(state.theme);
    renderSplash();
    if (state.token) {
      await bootApp();
      return;
    }
    await showAuth();
  }

  boot();
})();
