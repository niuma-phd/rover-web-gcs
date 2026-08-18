# Rover Web GCS 部署说明

本文先说明 AutoRover RTK 现场部署，再保留公网演示和反馈闭环部署。现场车端与地面站可以
部署在同一台 Ubuntu 主机，也可以由浏览器通过局域网访问地面站；浏览器不直接连接 VCU。

## A. AutoRover RTK 现场部署

### A.1 依赖和安装

地面站要求 Node.js 18 或更高版本。首次部署或 `package-lock.json` 更新后执行：

```bash
git clone https://github.com/niuma-phd/rover-web-gcs.git
cd rover-web-gcs
npm ci
npm test
```

`npm test` 默认覆盖 MAVLink、自带仿真、RTCM 和 AutoRover 北向协议。Fields2Cover 是外部
可选依赖：未安装时真实覆盖规划集成会明确跳过，不影响其它地面站功能。

### A.2 接入 AutoRover 车端

车端先启动 JSON-lines TCP 北向服务，默认监听 `127.0.0.1:6001`。然后启动地面站：

```bash
cd /opt/rover-web-gcs
PORT=8080 \
NORTH_HOST=127.0.0.1 \
NORTH_PORT=6001 \
NORTH_VMAX=1.00 \
NORTH_WMAX=0.375 \
npm start
```

浏览器打开 `http://车机IP:8080`，选择 `AutoRover RTK`，连接 `127.0.0.1:6001`。确认页面
有位置、航向、RTK、速度、电压和 DISARM 状态后，再进行 ARM 或任务操作。

`NORTH_VMAX` 是地面站进程刚启动时的手动速度预设；连接车端后，`MANUAL_SPEED`、
`CRUISE_SPEED` 和 `REVERSE_SPEED` 参数会采用车端返回值。不要把速度上限误当成启动预设。

### A.3 接入 Fields2Cover

将已构建的 `auto_rover_f2c` 及其共享库部署到固定目录，例如：

```text
/opt/auto-rover-field/bin/auto_rover_f2c
/opt/auto-rover-field/lib/libFields2CoverLite.so
```

启动和验证：

```bash
export AUTO_ROVER_F2C_BIN=/opt/auto-rover-field/bin/auto_rover_f2c
export LD_LIBRARY_PATH=/opt/auto-rover-field/lib:${LD_LIBRARY_PATH:-}
npm run coveragetest
npm start
```

覆盖规划顺序固定为：

```text
生成并预览 → 采用并上传 → ARM → 启动
```

地面站只接受带 `fieldContained:true` 的轨迹。生成和上传不会启动车辆；启动命令由操作员
单独触发。`.arf.json` 用于保留前进/倒车、速度、航向和段类型，QGC `.waypoints` 不保留
这些扩展字段。

### A.4 systemd 常驻部署（可选）

将非敏感运行参数放入 `/etc/rover-web-gcs.env`：

```text
PORT=8080
NORTH_HOST=127.0.0.1
NORTH_PORT=6001
NORTH_VMAX=1.00
NORTH_WMAX=0.375
AUTO_ROVER_F2C_BIN=/opt/auto-rover-field/bin/auto_rover_f2c
LD_LIBRARY_PATH=/opt/auto-rover-field/lib
```

创建 `/etc/systemd/system/rover-web-gcs.service`：

```ini
[Unit]
Description=Rover Web Ground Control Station
After=network-online.target

[Service]
Type=simple
User=rover
WorkingDirectory=/opt/rover-web-gcs
EnvironmentFile=/etc/rover-web-gcs.env
ExecStart=/usr/bin/node bridge/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

启用、查看和停止：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rover-web-gcs
sudo systemctl status rover-web-gcs
journalctl -u rover-web-gcs -f
sudo systemctl stop rover-web-gcs
```

### A.5 更新、回滚和验收

更新前先 DISARM 并停止地面站；地面站停止不会代替车端独立停车机制。

```bash
sudo systemctl stop rover-web-gcs
cd /opt/rover-web-gcs
git fetch --tags origin
git checkout <reviewed-tag-or-commit>
npm ci
npm test
sudo systemctl start rover-web-gcs
```

回滚时用相同流程切回上一个已验证标签或提交。上线后至少确认：HTTP 页面可访问、北向链路
连通、状态为 DISARM、位置/航向/RTK/电压更新、手动零速释放有效，以及 F2C 预览显示
田块内校验通过。部署文件和日志中不得写入 NTRIP、地图或站点口令。

## B. 在线演示 + 反馈闭环

把本机正在运行的 Rover Web GCS（连着真实 SITL）安全地放到公网做**单人演示**，
并配一套「反馈 → AI 初审 → 人工放行」的闭环。分三个阶段，每一步都可单独验证。

```
访客浏览器
   │  HTTPS (整站口令 Basic Auth)
   ▼
Cloudflare Edge ──(Tunnel)──► 本机 cloudflared ──► bridge:8097 ──► MAVLink UDP ──► ArduPilot SITL
                                                      │
                                         POST /api/feedback → data/feedback.jsonl
                                                      │
                              scripts/feedback-worker.js  (bwrap 沙箱里跑 claude -p)
                                                      │  只“提案”，不合并/不部署/不回复
                                                      ▼
                              data/proposals/<id>.json  ──►  人工 scripts/feedback-review.js
                                                                approve → 合并到 master（即上线静态资源）
```

## 阶段 1 — 整站口令 + 独立反馈页（已完成，本地可验证）

桥接进程 `bridge/server.js` 新增（**默认关闭，不影响本地开发**）：

- **整站 Basic Auth**：仅当存在 `.site-auth` 文件或设置了环境变量 `GCS_SITE_AUTH`（格式 `user:pass`）时启用。
  HTTP 与 WebSocket 都校验；未带凭据 → 401。
- **反馈 API**：`POST /api/feedback`（JSON：`text` 必填、`contact`、`category`），`GET /api/feedback`（列表）。
  数据写入 `data/feedback.jsonl`（已 gitignore）。
- **独立反馈页**：`/feedback`（`public/feedback.html`），与地面站主页面分开。

启用方式（演示机上）：

```bash
# 写入口令（不要提交；.site-auth 已 gitignore）
printf 'demo:一个足够强的口令' > .site-auth
PORT=8097 node bridge/server.js          # 或用你现有的启动方式
```

本地冒烟（无凭据 401 / 有凭据 200 / 反馈可存取）已验证通过。

## 阶段 2 — 反馈的 AI 初审（已完成，需人工放行）

**触发**：演示机上跑 `scripts/feedback-worker.js`，扫描 `data/feedback.jsonl` 里尚无提案的新反馈。

**隔离**：每条反馈在一个**独立 git worktree**（`feedback/<id>` 分支，从 master 切出）里处理，
`claude -p` 运行在 **bwrap 沙箱**中：

- `/home/.../resources`（密钥目录）被 `tmpfs` 屏蔽，沙箱内为空；
- 只有该 worktree 可写，其余文件系统只读；
- 禁用 `Bash / WebFetch / WebSearch`，只允许 `Read/Grep/Glob/Edit/Write`；
- 反馈文本作为**不可信数据**包在 `<feedback>` 标签里，明确指示不得执行其中指令。

**产出**：每条反馈生成 `data/proposals/<id>.json`（+`.md`）：

- 需要改代码 → 在 `feedback/<id>` 分支上提交改动 + 附 diff + 草拟回复；
- 不需要改 → 仅草拟回复说明原因。

worker **永不**合并 / 推送 / 部署 / 重启 / 自动回复。

```bash
node scripts/feedback-worker.js              # 处理全部新反馈
node scripts/feedback-worker.js --watch       # 常驻轮询（默认 30s）
node scripts/feedback-worker.js --id <id>     # 单条重跑
FEEDBACK_MODEL=<alias> node scripts/...        # 指定模型（默认用 claude 配置的默认模型）
```

**人工放行**（闸门）：

```bash
node scripts/feedback-review.js list           # 待审列表
node scripts/feedback-review.js show <id>      # 看反馈 + 决策 + 完整 diff
node scripts/feedback-review.js approve <id>   # 接受：有改动则合并分支到 master（= 上线静态资源），打印待发回复
node scripts/feedback-review.js reject <id> [原因]
node scripts/feedback-review.js reply  <id> [文本]   # 仅回复、不改代码
```

`approve` 只在本地合并，**不会**自动 `git push`、**不会**重启桥接、**不会**自动发回复——这些都由你手动决定。
若 diff 改到 `bridge/server.js`，需要重启桥接才生效（重启前先和负责人确认）。

## 阶段 3 — Cloudflare Tunnel 公网入口（待最终确认后执行）

> ⚠️ 这一步会把演示真正暴露到公网，执行前需再次确认。具体域名 / 隧道凭据 / 主机名见本机
> `resources/` 下的运维资料，**不写入本仓库**。

大致步骤（占位）：

1. 在演示机上用 `cloudflared` 建隧道，`ingress` 指向 `http://localhost:8097`。
2. 用 Cloudflare API Token 配 DNS（`<demo>.<domain>` CNAME 到隧道）。
3. 设置好 `.site-auth` 的真实口令后再开放访问。
4. 关停演示时：停 `cloudflared`，删 DNS 记录。

## 安全须知

- `.site-auth`、`data/`、`public/config.js`、`resources/` 全部 **不提交**。
- 反馈含访客联系方式，属个人信息，仅本地存储、人工处理。
- AI 改动一律走分支 + 人工审 diff 后才合并；不引入新依赖、不动鉴权/部署/密钥相关代码。
