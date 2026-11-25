# Cloud Mail

一个跑在 **Cloudflare Worker + D1** 上的极简邮件收发站：接收 Email Routing 投递进来的邮件，并支持用账号登录后在浏览器里读信、写信。

界面走「三栏 + 等宽阅读区」的现代邮箱布局，浅色 / 深色 / 跟随系统三套主题，桌面与手机都能用。

> 本项目是 [LhyCloud/Cloudflare-Email-Worker](https://github.com/LhyCloud/Cloudflare-Email-Worker) 的重构版本：
> 界面重做、**数据库自动创建**、**支持多账号（管理员 + 普通用户）**，并顺手修掉了原版的若干安全问题。

---

## 相比原版做了什么

| 方面 | 原版 | 现在 |
| --- | --- | --- |
| 建表 | 需要手动把 `D1.txt` 粘进 D1 控制台 | **首次请求自动建表**，老库缺少的列会自动补齐，历史邮件自动归到对应账号 |
| 账号 | 代码里硬编码一个 `admin`，全局一个静态 token | 首次打开有**初始化向导**，之后管理员可在界面里增删账号；支持 `admin` / `user` 两种角色 |
| 地址 | 域名写死在代码里 | **收件域名自动识别**：显式配置 → 收到的第一封邮件 → 访问域名；地址只需填前缀，管理员默认 `admin@<域名>` |
| 密码 | 明文写在源码里 | PBKDF2-SHA256（10 万轮，运行时可配置但不超过上限）加盐哈希，登录失败有频次限制（15 分钟 8 次） |
| 会话 | 静态 token，永不过期 | D1 里的随机令牌，库里只存 SHA-256，默认 7 天过期；改密后其他会话、管理员重置密码、停用账号都会立即失效 |
| 邮件解析 | 正则硬凑，`\r\n` 处理粗糙，附件直接丢 | 递归解析 MIME（multipart / base64 / quoted-printable / RFC 2047 主题），保留附件信息，支持 HTML 与纯文本正文 |
| 阅读 | HTML 直接 `innerHTML` 塞进页面（XSS 风险） | `sandbox` iframe 渲染，内容侧 CSP 限制到 `default-src 'none'`，外部图片默认不加载，点一下才显示 |
| 功能 | 只有收件箱 / 已发送列表 | 收件箱、星标、已发送、垃圾箱，关键词搜索、分页、已读未读、星标、软删除与彻底删除 |
| 发信 | 只能用账号自己的地址 | 一键**回复**（自动引用原文）；**管理员可指定发件人**，代任意地址发信 |
| 垃圾箱 | 无 | 删除进垃圾箱，**30 天后自动清除**（`TRASH_RETENTION_DAYS` 可调），右键可恢复 |
| 列表操作 | 只能点开 | 列表右键菜单：打开、回复、标已读/未读、星标、删除、恢复；已发送也能右键删除记录 |
| 保留策略 | 固定只留 200 封 | **全站最多保留 500 封**（`MAIL_RETENTION` 可调，跨账号一起算，超出清理最旧的）；删除的进垃圾箱，30 天后自动清除 |
| 自动化 | 无 | **邮件接口密钥**（`cm_…`）：脚本用 `x-api-key` 头直接调 `/api/*` 收发 |
| 多账号隔离 | 无 | 每封邮件归属一个账号，接口层强制校验属主，越权读取返回 404 |
| 部署 | 手工粘贴代码 + 手工建表 | `npm run deploy` 一条命令，或仍然可以直接粘贴 `dist/worker.js` |

---

## 快速开始

### 方式一：Wrangler 部署（推荐）

```bash
# 1. 安装依赖（只用于部署，运行时代码零依赖）
npm install

# 2. 创建 D1 数据库
npx wrangler d1 create cloud-mail
#    把输出里的 database_id 填进 wrangler.toml

# 3. 构建并部署
npm run deploy
```

部署完成后打开 Worker 域名，第一次访问会进入**初始化向导**：域名会自动识别出来，管理员地址默认就是 `admin@你的域名`，只需要设置一个密码。

### 方式二：完全在 Cloudflare 控制台里操作

1. 新建 Worker，把 `dist/worker.js` 的内容整体粘贴进去（`npm run build` 生成，单文件、无依赖）。
2. 新建一个 D1 数据库，在 Worker 的 **Settings → Bindings** 里绑定，变量名必须是 `DB`。
3. 在 **Settings → Bindings** 里再加一个 **Send Email** 绑定，变量名必须是 `EMAIL`（用于发信）。
4. 绑定自定义域名（或用 `workers.dev`），打开后按向导初始化。

> 数据表不用建，也不用跑 SQL：`schema.sql` 只是给人看的参考，运行时由代码自动创建。

### 接收邮件

在 **Email Routing → Email Workers** 里把邮件路由到这个 Worker：

- 想接住整个域名的所有来信：开启 **Catch-all**，动作选 *Send to a Worker*，选中这个 Worker；
- 只想收某个地址：新建一条自定义地址规则指向它。

收信时按「收件地址 @ 前面的部分」匹配账号：`hi@example.com` 会进到邮箱前缀为 `hi` 的账号。匹配不到账号的邮件也不会丢——一律归到管理员账号，邮件里会标出原始收件地址并带上「代收」标记；旧版本遗留在库里的无主邮件，在下次启动时也会自动归到管理员。

如果怀疑「无主邮件没进来」，去 **账号管理 → 收信诊断** 点一下检查：它会给出总邮件数、当前滞留的无主邮件（含主题和原始收件地址）、各账号收件数、管理员账号与收件域名来源。发现滞留邮件时，卡片里会出现「把这 N 封无主邮件归到管理员」按钮，一键追回。

### 收件域名自动识别

不用手工把域名抄进代码：Worker 会自己判断当前收发用的是哪个域名，取第一个能拿到的来源。

| 来源 | 说明 |
| --- | --- |
| `MAIL_DOMAIN` 变量 | 显式配置，永远优先 |
| `settings.mail_domain` 表 | 收到第一封邮件（或首次初始化）时自动写入，之后一直复用 |
| 访问域名 | 用 `mail.example.com` / `email.example.com` 访问时推断出 `example.com`；`*.workers.dev` 不推断 |

识别到域名之后：

- 网页上所有地址输入框都变成「**填前缀 + 自动补 @域名**」，登录、新建账号、初始化都只填 `admin`、`chenzhou` 这样的前缀；
- 初始化向导的管理员默认地址是 `admin@<域名>`，地址框默认就填好了 `admin`，改前缀即可；
- 用 `ADMIN_PASSWORD`（可配 `ADMIN_EMAIL`，只填前缀也行）引导管理员时，默认创建的就是 `admin@<域名>`；
- 万一域名识别不到（没有 `MAIL_DOMAIN`、还没收到过任何邮件、又是 `workers.dev` 访问），界面会提示填完整地址或去配 `MAIL_DOMAIN`，不会静默出错。

### 发送邮件

1. 确认已在 Worker 里绑定了名为 `EMAIL` 的 Send Email 绑定；
2. 在 **Email Routing → Destination addresses** 里验证收件人地址（Cloudflare 的限制：未验证的地址发不出去）；
3. 网页里写信即可。普通账号的发件人固定为自己，不能伪造；管理员多出一个「发件人」输入框，只填前缀（如 `billing`）就会自动补成 `billing@<域名>`，留空则用自己账号的地址。

---

## 本地开发

```bash
npm run build   # 把 src/ 与 src/ui/ 打包成 dist/worker.js + dist/index.html
npm run dev     # 起一个本地预览服务（用 node:sqlite 模拟 D1，带演示邮件）
npm test        # 构建 + 跑接口测试（76 项）+ 旧库升级 + 域名识别测试
npm run check   # 检查界面里用到的 class / CSS 变量是否都有定义
npm run smoke   # 对正在运行的实例跑一遍关键流程（需先 npm run dev 起服务）
```

`npm run dev` 之后打开：

- `http://127.0.0.1:8787/__preview` —— 自动登录并进入收件箱（附带一批演示邮件，垃圾箱里也有一封）
- `http://127.0.0.1:8787/__preview?logout=1` —— 登录页
- 加 `&theme=dark` 可以看深色主题

演示账号：`admin@example.com` / `admin-password-1`。

> 本地预览用 `node:sqlite`（Node 22.5+ 自带）模拟 D1，因此不需要安装任何依赖，也不需要联网。

### 需要 wrangler 的真实本地调试

```bash
npm run build
npx wrangler d1 execute cloud-mail --local --file=schema.sql   # 可选的显式建表
npx wrangler dev
```

实际上第 2 步也可以省掉——Worker 启动后的第一次请求会自动建表。

---

## 配置项

都在 `wrangler.toml` 的 `[vars]` 里，全部可选：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAIL_DOMAIN` | 空 | 收件域名。留空时会在收到第一封邮件后自动识别，也可从 `mail.<域名>` 形式的访问域名推断 |
| `ADMIN_EMAIL` | `admin@<域名>` | 与 `ADMIN_PASSWORD` 一起填可在首次启动时自动创建管理员；只填前缀（如 `admin`）会自动补域名 |
| `ADMIN_PASSWORD` | 空 | 同上，至少 8 位 |
| `MAIL_RETENTION` | `500` | **全站**保留的邮件条数上限（所有账号加起来，超出后清理最旧的；已发送同理）。填 20–5000 可调，填 `0` 关闭清理（等于不限） |
| `TRASH_RETENTION_DAYS` | `30` | 垃圾箱邮件保留天数，过期在下次访问时自动删除（1–365） |
| `SESSION_TTL_DAYS` | `7` | 登录会话有效期（天） |
| `PBKDF2_ITERATIONS` | `100000` | 密码哈希迭代次数。Workers 的 WebCrypto 上限就是 10 万轮，配更大也会被自动压回上限 |

> 用环境变量创建管理员只会在「库里还没有任何账号」时生效，之后改这些变量不会覆盖已有密码。

---

## 角色权限

| 能力 | 普通用户 `user` | 管理员 `admin` |
| --- | --- | --- |
| 读 / 写 / 管理自己的邮件 | ✅ | ✅ |
| 修改自己的昵称、密码、主题 | ✅ | ✅ |
| 查看统计概览 | ❌ | ✅ |
| 创建 / 停用 / 删除账号 | ❌ | ✅ |
| 重置他人密码 | ❌ | ✅ |
| 指定发件人地址（代发） | ❌ | ✅ |
| 代收无主邮件（收件地址没有对应账号） | ❌ | ✅ |
| 创建接口密钥调用 `/api/*` | ✅ | ✅ |

给普通账号开放的能力：收信、读信、搜索、星标、删除、发信、改自己的资料。账号本身由管理员创建——避免邮箱域名被随意注册。为防止误操作，管理员不能把自己降级、也不能删掉最后一个管理员。

---

## 接口一览

所有接口返回 JSON：成功是 `{ ok: true, ... }`，失败是 `{ ok: false, error: { code, message } }`。除初始化与登录外，都需要请求头 `Authorization: Bearer <token>`；脚本调用也可以改用接口密钥 `x-api-key: cm_…`（见下一节）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/setup` | 是否需要初始化（`needsSetup` / `userCount` / `domain` / `defaultAdmin`） |
| POST | `/api/setup` | 初始化第一个管理员账号；`email` 可省略，默认 `admin@<域名>` |
| POST | `/api/auth/login` | 登录，返回令牌与用户信息 |
| POST | `/api/auth/logout` | 退出登录，销毁当前令牌 |
| GET | `/api/me` | 当前用户、域名、邮箱地址与各分类计数 |
| PATCH | `/api/me` | 修改昵称 |
| POST | `/api/me/password` | 修改自己的密码 |
| GET | `/api/mails?box=&q=&page=` | 邮件列表，`box` 取 `inbox` / `starred` / `trash` / `sent` |
| GET | `/api/mails/:id` | 邮件详情 |
| PATCH | `/api/mails/:id` | 标记已读 / 星标；`{"restore":true}` 从垃圾箱恢复 |
| DELETE | `/api/mails/:id` | 删除；`?permanent=1` 为彻底删除 |
| POST | `/api/mails/trash/empty` | 清空垃圾箱 |
| POST | `/api/mails/send` | 发信；管理员可额外传 `from` 指定发件人，只填前缀时自动补域名 |
| GET | `/api/sent/:id` | 已发送邮件详情 |
| DELETE | `/api/sent/:id` | 删除一条发件记录（只删本地记录，发出去的邮件收不回来） |
| GET | `/api/keys` | 当前账号的接口密钥列表 |
| POST | `/api/keys` | 新建接口密钥（明文只返回一次） |
| POST | `/api/keys/:id/revoke` | 撤销接口密钥（彻底删除记录） |
| GET | `/api/users` | 账号列表（管理员） |
| POST | `/api/users` | 新建账号（管理员）；`email` 可只填前缀，域名自动补全 |
| PATCH | `/api/users/:id` | 改昵称 / 角色 / 状态（管理员） |
| POST | `/api/users/:id/password` | 重置他人密码（管理员） |
| DELETE | `/api/users/:id` | 删除账号并清理其邮件（管理员） |
| GET | `/api/admin/overview` | 统计概览（管理员） |
| GET | `/api/diagnostics` | 收信诊断：域名来源、无主邮件、各账号收件数（管理员） |
| POST | `/api/diagnostics/adopt` | 把滞留的无主邮件一次性归到管理员（管理员） |
| GET | `/healthz` | 健康检查 |

---

## 自动化收发（接口密钥）

界面里登录 → **设置 → 邮件接口密钥 → +** 新建一个密钥。密钥形如 `cm_` + 48 位十六进制，**明文只在创建时显示一次**，库里只存它的 SHA-256；点「撤销」会把这条记录从库里彻底删除，不留残余。

用 `x-api-key` 头代替 `Authorization: Bearer` 就能调用全部邮件接口：

```bash
# 拉取收件箱（第一页 25 封）
curl -H "x-api-key: cm_你的密钥" "https://mail.example.com/api/mails?box=inbox"

# 只取未读
curl -H "x-api-key: cm_你的密钥" "https://mail.example.com/api/mails?box=inbox&unread=1"

# 关键词搜索
curl -H "x-api-key: cm_你的密钥" "https://mail.example.com/api/mails?q=发票"

# 读一封邮件（含正文、正文类型、附件信息）
curl -H "x-api-key: cm_你的密钥" "https://mail.example.com/api/mails/12"

# 发信
curl -X POST "https://mail.example.com/api/mails/send" \
  -H "x-api-key: cm_你的密钥" -H "content-type: application/json" \
  -d '{"to":"someone@example.net","subject":"来自脚本","body":"正文内容"}'

# 管理员密钥可以代指定地址发信
curl -X POST "https://mail.example.com/api/mails/send" \
  -H "x-api-key: cm_管理员密钥" -H "content-type: application/json" \
  -d '{"from":"notice@example.com","to":"user@example.net","subject":"系统通知","body":"维护公告"}'

# 标记已读 / 加星标 / 移入垃圾箱 / 恢复
curl -X PATCH "https://mail.example.com/api/mails/12" -H "x-api-key: cm_你的密钥" \
  -H "content-type: application/json" -d '{"isRead":true}'
curl -X DELETE "https://mail.example.com/api/mails/12" -H "x-api-key: cm_你的密钥"
curl -X PATCH "https://mail.example.com/api/mails/12" -H "x-api-key: cm_你的密钥" \
  -H "content-type: application/json" -d '{"restore":true}'
```

小提示：

- 每个账号最多 20 个密钥，够区分不同脚本；撤销立即生效，且该记录会被彻底删除。
- 密钥继承账号的全部权限：普通账号的密钥只能管自己的邮件，调管理接口会返回 403。
- 想接收「有人发了什么」这类通知，最简单的是定时拉 `/api/mails?box=inbox&unread=1`，处理完再 `PATCH {"isRead":true}`。

---

## 目录结构

```
cf-email-worker/
├── src/
│   ├── index.js          入口：路由、静态页面、CSP、错误兜底
│   ├── bootstrap.js      启动流程：自动建表 + 环境变量引导管理员
│   ├── email.js          收信：MIME 解析 → 匹配账号 → 入库 → 去重
│   ├── api/
│   │   ├── auth.js       初始化、登录、退出、个人资料
│   │   ├── keys.js       接口密钥管理
│   │   ├── mails.js      列表、详情、已读/星标、删除、发信、垃圾箱清理
│   │   └── users.js      管理员账号管理
│   ├── lib/
│   │   ├── apikeys.js    接口密钥的生成、校验与撤销删除
│   │   ├── auth.js       PBKDF2 密码与 D1 会话
│   │   ├── db.js         自动建表、列补齐、查询封装
│   │   ├── domain.js     收件域名自动识别与地址补全
│   │   ├── http.js       JSON 响应、鉴权、安全响应头
│   │   ├── mime.js       MIME / RFC 2047 / 附件解析
│   │   └── util.js       字符串、邮箱、哈希等小工具
│   └── ui/
│       ├── index.html    页面骨架
│       ├── styles.css    设计变量与全部组件样式
│       └── app.js        单页应用逻辑（无框架）
├── scripts/
│   ├── build.mjs         零依赖打包：内联模块与界面 → dist/worker.js
│   ├── preview.mjs       本地预览服务（node:sqlite 模拟 D1）
│   ├── test.mjs          接口集成测试（76 项）
│   ├── test-domain.mjs   域名自动识别 / 地址补全测试（32 项）
│   ├── test-upgrade.mjs  旧库升级测试
│   ├── smoke.mjs         对运行中的实例跑关键流程
│   └── check-ui.mjs      界面 class / CSS 变量自检
├── dist/                 构建产物（worker.js 单文件 + index.html）
├── schema.sql            建表语句参考（运行时自动执行等价逻辑）
└── wrangler.toml         部署配置
```

---

## 常见问题

**收不到邮件？**
检查三件事：Email Routing 里是否把邮件路由到了这个 Worker；D1 绑定名是否为 `DB`；收件地址的前缀是否对应某个账号。可以访问 `/healthz` 与 `/api/setup` 快速确认服务是否正常。

**发到不存在的地址的邮件去哪了？**
会自动进管理员账号的收件箱，收件人一栏显示原始的收件地址并标上「代收」。所以哪怕域名下开了任意前缀收信，也不会有邮件落到没人看得到的地方。
如果管理员的收件箱里确实没有，按这个顺序查：① Email Routing 有没有开 **Catch-all**（只配了自定义地址规则时，发给其他前缀的邮件根本不会送到 Worker）；② **账号管理 → 收信诊断** 里 `无主` 是否为 0——大于 0 就点「归到管理员」；③ 看 `wrangler tail` 日志里有没有 `[orphan] ... 已归到 ...` 或 `inbound email failed`。

**发件人名字后面多了个引号（如「星夜_Lhy"」）？**
旧版本从 `From: "显示名" <x@qq.com>` 这类写法里剥引号时先剥引号再 trim，末尾那个引号会漏掉。现在统一走 `cleanDisplayName()`：先去掉首尾空白，再剥掉成对的 `"`/`'`/`“”`，并还原 `\"` 转义；库里已有的脏数据在读取时也会被清洗，不用手动改库。

**发信报「收件地址未通过验证」？**
Cloudflare 要求先把目标地址加入 Email Routing 的 Destination addresses 并完成验证，这是平台限制，不是代码问题。

**认不出收件域名 / 地址框里没有 @后缀？**
说明三个来源都还没拿到域名：`MAIL_DOMAIN` 没填、库里还没收到过任何邮件、而且是用 `xxx.workers.dev` 访问的（这类地址不会被当成收件域名）。随便填一次完整地址（例如 `admin@你的域名`）就能继续，之后系统会记住；更省事的做法是在 `wrangler.toml` 里把 `MAIL_DOMAIN` 填上。

**忘记管理员密码？**
用另一个管理员账号在「账号管理」里重置；如果只剩一个账号且密码丢了，可以在 D1 控制台执行
`DELETE FROM users; DELETE FROM sessions;` 后重新打开页面走初始化向导（会清空账号，邮件仍保留在库里）。

**登录报「password_reset_required」或控制台出现 `NotSupportedError: Pbkdf2 failed: iteration counts above 100000`？**
Workers 的 WebCrypto 最多只支持 10 万轮 PBKDF2。旧版本用 12 万轮写入的密码哈希在这类运行时里无法重算，所以请管理员在「账号管理」里对该账号点一次「重置密码」（或用另一个管理员账号登录后重置），之后写入的就是 10 万轮；新账号不会再有这个问题。
如果被卡住的正是唯一的管理员：临时配置 `ADMIN_PASSWORD` 再访问一次页面即可——自检发现有管理员的哈希轮数超出上限时，会用 `ADMIN_PASSWORD` 把它重置回 10 万轮（不配这个变量则不动任何账号）。

**邮件会一直堆着吗？**
不会无限堆：**全站最多留 500 封**（`MAIL_RETENTION` 可调 20–5000，所有账号一起算，超出后清理最旧的；填 `0` 就关掉清理）。只有主动删除的邮件才进垃圾箱，垃圾箱里的邮件保留 30 天后自动清除（`TRASH_RETENTION_DAYS` 可改，1–365 天），也可以在垃圾箱里点「清空」立刻删除。附件只保存文件名、类型和大小，正文与附件内容都不落盘，避免撑爆 D1 的存储配额。

**已发送的邮件能删掉吗？**
能，但只是删掉你这里的发件记录（对方邮箱里的邮件收不回来）。阅读器右上角的删除按钮、或者右键列表里的「删除发件记录」都可以删；接口是 `DELETE /api/sent/:id`。

**能在别的地方复用这些接口吗？**
可以，接口是普通的 JSON + Bearer 令牌，`curl` 就能调：
```bash
TOKEN=$(curl -s -X POST https://your-worker/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"your-password"}' | jq -r .token)

curl -s "https://your-worker/api/mails?box=inbox" -H "Authorization: Bearer $TOKEN" | jq
```

---

## 许可

与原项目保持一致，仅供学习与自用部署。
