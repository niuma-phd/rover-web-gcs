# 无人车 Web 地面站 (MVP)

面向 **ArduPilot Rover** 的轻量级 Web 地面站最小可用版本。
浏览器界面（地图 / 遥测 / 压航点 / 发命令）+ Node 桥接进程（持有飞控链路、收发 MAVLink）。

```
浏览器(Leaflet UI)  <--WebSocket(JSON)-->  Node 桥接  <--MAVLink(串口/UDP/TCP)-->  ArduPilot Rover 飞控
```

> **为什么要桥接进程？** 浏览器不能直接打开串口/UDP，所以必须有一个本地 Node 进程
> 持有与飞控的物理链路，并把 MAVLink 帧翻译成浏览器能用的 JSON。这是 Web 地面站绕不开的一环。

MAVLink 编解码使用成熟开源库 [`node-mavlink`](https://www.npmjs.com/package/node-mavlink)（支持 common + ardupilotmega，MAVLink v2）。

---

## 1. 安装

```bash
cd web-gcs
npm install
```
> `serialport` 是可选依赖（连真实串口数传时才需要）。若它在某些环境编译失败，不影响 UDP/TCP 使用。

## 2. 运行

```bash
npm start          # 或: node bridge/server.js
```
浏览器打开 **http://localhost:8080** （改端口：`PORT=9000 npm start`）。

在页面左上角选择链路并点「连接」：
- **UDP**：填监听端口（默认 14550）。适合 WiFi 数传、SITL 仿真。
- **TCP**：填 `host:port`（如 SITL 的 `127.0.0.1:5760`）。
- **串口**：填串口号（Windows 如 `COM3`）+ 波特率（数传常用 57600，USB 直连常用 115200）。

## 3. 不接飞控也能先验证（自测）

```bash
npm run selftest          # 校验 node-mavlink API + heartbeat 编解码闭环
node bridge/itest.js      # 端到端：假飞控 + 桥接 + WS 客户端，验证遥测/命令/任务上传
```

## 4. 用 ArduPilot SITL 仿真测试（推荐，先不上真车）

SITL 启动 Rover 后，让它把 MAVLink 输出到本机：
```bash
# 在 ardupilot 目录：
sim_vehicle.py -v Rover --out=udp:127.0.0.1:14550
# 或用 TCP：地面站选 TCP 连 127.0.0.1:5760
```
地面站选 **UDP / 监听 14550**（或 TCP / 5760）→ 连接 → 应能看到车辆出现在地图、遥测刷新；
可解锁、切 AUTO、压航点并「上传任务」「启动」。

## 5. 连真实飞控

1. 数传/USB 接到电脑，确认串口号（设备管理器）。
2. 地面站选「串口」，填串口号 + 波特率，连接。
3. 看到心跳后即可发命令。**首次务必在安全环境（车轮架空/空旷场地）测试解锁与运动指令。**

---

## 已实现的 MVP 功能

- **连接**：串口 / UDP / TCP；GCS 心跳保活；自动请求数据流（4Hz）；断线状态提示。
- **地图**：Leaflet（街道图 OSM / 卫星图 Esri，本地内置可离线）；车辆位置 + 航向箭头 + 轨迹；Home 标记。
- **遥测**：飞行模式、武装状态、地速、航向、GPS 定位类型/卫星数、电压/电量、经纬度。
- **压航点**：点击地图加点、拖动微调、删除；上传任务（完整 MISSION 协议握手）/ 下载任务 / 清空。
- **发命令**：解锁/上锁、设置模式（Rover 模式）、返航 RTL、启动任务(AUTO)、**急停（强制上锁）**、Shift+点击地图引导前往(Guided Goto)。
- **日志**：飞控 STATUSTEXT（按严重度分色）、命令 ACK、链路事件。

## 目录结构

```
web-gcs/
├── package.json
├── bridge/
│   ├── server.js     # 桥接 + 静态服务（核心）
│   ├── selftest.js   # node-mavlink API 自检 + 编解码闭环
│   └── itest.js      # 端到端集成测试（假飞控）
└── public/
    ├── index.html
    ├── app.js        # 前端逻辑（WS / 地图 / 航点 / 命令）
    ├── style.css
    └── vendor/leaflet # 本地内置 Leaflet（离线可用）
```

## 桥接 WebSocket 协议（前后端约定，便于二次开发）

浏览器 → 桥接：`{t:'connect'|'disconnect'|'arm'|'mode'|'rtl'|'startMission'|'estop'|'goto'|'setHome'|'setCurrent'|'uploadMission'|'downloadMission'}`
桥接 → 浏览器：`{t:'link'|'hb'|'pos'|'gps'|'sys'|'vfr'|'text'|'ack'|'home'|'mission_current'|'mission_reached'|'mission_uploaded'|'mission_list'|'log'|'stale'|'snapshot'}`

## MVP 范围说明 / 后续

- 飞控固件：按需求只面向 **ArduPilot Rover（APM）**，MAVLink v2。
- 暂未含：RTK/NTRIP、避障/近距传感器可视化、手柄遥控、视频、参数面板、围栏编辑、检查单、国内地图(天地图)与 GCJ-02 坐标纠偏 —— 这些是需求文档里的下一批功能，可在此骨架上增量添加。
- 中国地图：当前用 OSM/Esri（WGS-84，无偏移）。若改用天地图，需补 WGS-84→GCJ-02 坐标纠偏，否则车标会和卫星底图错位。
- 已知工程项：前端航点列表用 innerHTML 渲染数值坐标（本地工具、数据来自自身，非外部输入）；生产化时建议改 DOM 构造或加 CSP。
