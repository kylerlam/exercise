# Exercise

私人的健身记录应用，沿用 Daily Todo 与 CirGrid 的代码架构、登录流程和界面风格。

[在线 Demo](https://exercise-demo-442.pages.dev) · [正式应用](https://exercise.kylermaker.com) · [GitHub](https://github.com/kylerlam/exercise) · [版本记录](CHANGELOG.md)

Demo 使用独立的浏览器示例数据，按香港日期每日重置，不连接正式应用的账号或数据库。

## 打开应用

默认地址：<http://127.0.0.1:4186>

首次登录：用户名 `admin`，密码 `admin123`。进入右上角设置，可修改用户名和密码。修改账号后，所有设备需要重新登录。

双击本目录的 `启动 Exercise.command`，或在项目目录运行：

```sh
python3 -B scripts/run.py start
```

启动器会让服务在后台持续运行，关闭启动终端不会停止服务。重复启动会复用已经运行的实例。

```sh
python3 -B scripts/run.py status
python3 -B scripts/run.py stop
```

需要 Python 3.11 或更新版本；没有第三方运行依赖，也不需要安装前端包。默认只监听本机回环地址。服务关闭、电脑关机或休眠时无法访问；重新启动可使用同一入口，数据保持不变。

## 记录训练

- **每日记录**：选择日期，逐条添加动作。力量训练按照“部位 → 动作 → 组数 → 次数”的横向顺序显示；组数和每组次数都必须是 1–10000 的整数。一天可记录多个动作，也可补记其他日期。
- **有氧**：选择有氧类型，填写运动、分钟数、可选公里数及备注；时长和距离可使用小数。分钟数上限 10080，公里数上限 100000。
- **日历**：切换月份或点击某一天，查看当日训练；力量和有氧分别标记。
- **月统计**：保留每月训练记录表的“日期 / 训练记录”结构，连续显示当月所有实际日期。简写例如“腿：深蹲×4×15”，表示 4 组，每组 15 次；总次数按组数乘以每组次数累计。有氧记录保留分钟和公里数，顶部另行汇总有氧总分钟。
- **设置**：沿用原应用的 10 个主题、4 种界面语言、密码显示切换及账号管理。
- **导出数据**：下载包含所有训练记录的 JSON 文件；导出不包含密码或会话。

保存成功后数据写入 SQLite；网络或校验失败时输入保留。每条记录有独立版本号，同一条记录发生并发编辑时会提示冲突，不会静默覆盖其他页面的更改。删除需要确认。

## 数据与结构

```text
backend/server.py    HTTP API、登录、SQLite 持久化
dist/                原生 JavaScript 模块、HTML、CSS
tests/               后端集成测试、日期和统计模型测试
scripts/             本机启动器与静态检查
data/                本机私有数据库（运行时创建）
.runtime/            后台进程号与日志（运行时创建）
```

数据库位于 `data/exercise.sqlite3`，与 Daily Todo、CirGrid 的账号和记录完全独立。运行时会产生 SQLite 的 `-wal`、`-shm` 文件。搬移数据前先停止服务，再完整复制 `data/`；不要只复制运行中的主数据库文件。程序和运行数据分开保存，升级代码时保留 `data/`。

正式版以 SQLite 保存训练数据；浏览器保存主题、语言和登录后的返回位置，会话过期时还会在当前标签页暂存未保存的训练草稿，重新登录后恢复。主动退出会清除待恢复草稿。本应用无用户注册，沿用参考应用的单账号个人空间模式。

## 检查与测试

```sh
python3 -B -m unittest discover -s tests -v
node --test tests/*.test.mjs
node scripts/check.mjs
```

测试使用临时数据库，不写入日常使用的 `data/`。Node.js 仅用于开发检查；运行应用本身不需要 Node.js。

浏览器回归测试使用已有 Playwright 和 Chromium，不自动安装依赖：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROMIUM_PATH=/path/to/chromium node tests/browser-regressions.cjs
BROWSER_ENGINE=webkit PLAYWRIGHT_MODULE=/path/to/playwright WEBKIT_PATH=/path/to/pw_run.sh node tests/browser-regressions.cjs
```

覆盖手机布局的四种语言、Optional 标签对齐、并发冲突恢复、跨午夜 Today、过期会话草稿恢复和存储受限场景。后端、模型、Demo 数据及静态检查均可直接在本机运行，无需安装运行依赖。

## Pages Demo

```sh
node scripts/build-demo.mjs
```

默认输出到 `.runtime/demo/`；也可传入一个独立的空输出目录。只复制公开前端资源，以浏览器存储适配器替换正式 API，不包含登录页、数据库、账号、服务端或私有配置。示例数据在香港午夜后自动恢复，也可手动重置；同一浏览器多个标签页通过 Web Locks 串行保存。

Cloudflare Pages 使用 `exercise-demo` 项目和 `codex/demo` 生产分支。部署生成的目录，不要直接上传正式版 `dist/`。

## 容器运行

已提供 Dockerfile 和 Compose 配置，便于之后部署到自己的服务器：

```sh
docker compose up -d --build
```

默认仍只绑定本机 `127.0.0.1:4186`，数据挂载 `./data`。HTTPS 反向代理使用 `SESSION_COOKIE_SECURE=true`。

NAS 配置见 `deploy/compose.nas.yaml`，使用独立 `exercise` 项目、`exercise-app` 容器及预构建的 AMD64 版本化镜像；服务端只保留运行配置和 `data/`。`EXERCISE_BIND_HOST` 由部署环境设置，避免默认向所有网卡开放。更新镜像时保留数据目录，并验证健康接口、账号登录、重启持久化及 DSM 项目归属。

原应用参考源码为 MIT License；主题和基础界面样式沿用其授权，见 LICENSE。
