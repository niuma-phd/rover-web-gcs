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
node bridge/itest.js      # 端到端：假飞控 + 桥接 + WS 客户端，验证遥测/命令/任务上传（13/13）
node sim/simtest.js       # 全场景：解锁→围栏→任务驾驶→越界告警→手柄遥控，验证车辆真的会动（8/8）
```

## 4. 内置仿真环境（无需 ArduPilot SITL，推荐先在这里试）

仓库自带一个**行为级 ArduRover 仿真**（`sim/rover-sim.js`）——它通过 UDP 向桥接发送
真实的 MAVLink 遥测、并对解锁/模式/任务/围栏/RC 遥控做出反应（会在地图上真的开起来），
方便在没有硬件、也没装 SITL 的情况下完整体验地面站。

```bash
# 终端 A：启动地面站（桥接 + 页面）
npm start
# 终端 B：启动仿真车（默认对接桥接 127.0.0.1:14550）
node sim/rover-sim.js
#   可选环境变量：SIM_LAT / SIM_LON 起点，BRIDGE_PORT 桥接端口
```
浏览器打开 http://localhost:8080 → 选 **UDP / 监听 14550** → 连接 →
车辆出现在地图（起点默认深圳附近）。可解锁、压航点上传并「启动任务」看它自动驾驶、
画地理围栏看越界告警、用「启用遥控」+手柄/键盘手动驾驶。

### 4b. 用真正的 ArduPilot Rover SITL（真实固件，已在本机验证 ✅）

跑的是**真正的 ArduPilot Rover 固件**（SITL = Software-In-The-Loop），不是行为级仿真。
本地端到端测试 `sim/sitltest.js` 对真实固件 **8/8 通过**（解锁 → GUIDED 引导驾驶 →
任务上传握手 → AUTO 任务 → RTL 返航 → 上锁）。

**一次性准备：**
```bash
# 1) 构建依赖（Ubuntu）
sudo apt-get install -y build-essential ccache gawk python3-dev python3-venv \
  libtool libxml2-dev libxslt1-dev pkg-config rsync

# 2) python venv（注意 empy 必须是 3.3.4，4.x 会让 waf 构建失败）
python3 -m venv ../apvenv && source ../apvenv/bin/activate
pip install pymavlink MAVProxy "empy==3.3.4" future

# 3) 拉源码并构建 Rover SITL
git clone --recurse-submodules https://github.com/ArduPilot/ardupilot.git ../ardupilot
cd ../ardupilot && ./waf configure --board sitl && ./waf rover
```

**运行（每次）：**
```bash
# 终端 A：启动真实固件 SITL（默认起点 22.59,113.95，转发 MAVLink 到 UDP 14550）
./scripts/run-sitl.sh
# 终端 B：启动地面站
npm start
# 浏览器：选 UDP / 监听 14550 → 连接，即可看到真实固件驱动的车辆
```
> 关键点：**不要**给 `sim_vehicle.py` 再加 `--out=udp:127.0.0.1:14550` —— 它默认已经转发到
> 14550，再加一个会重复输出（MAVProxy 两个源端口 → 桥接 UDP 套接字来回跳），会破坏任务上传的多轮握手。
> `scripts/run-sitl.sh` 已按此处理。

**自动化验证（真实固件）：**
```bash
./scripts/run-sitl.sh          # 终端 A
node sim/sitltest.js           # 终端 B：自动解锁→GUIDED 驾驶→任务→RTL→上锁，打印 8/8
```
> 真实固件须等 EKF 收敛后才允许进 GUIDED/AUTO；`sitltest.js` 会先等 3D 定位再带重试地切模式。

或用 TCP：地面站选 **TCP** 连 `127.0.0.1:5760`。

## 5. 连真实飞控

1. 数传/USB 接到电脑，确认串口号（设备管理器）。
2. 地面站选「串口」，填串口号 + 波特率，连接。
3. 看到心跳后即可发命令。**首次务必在安全环境（车轮架空/空旷场地）测试解锁与运动指令。**

---

## 已实现的 MVP 功能

- **连接**：串口 / UDP / TCP；GCS 心跳保活；自动请求数据流（4Hz）；断线状态提示；连接配置本地记忆。
- **地图**：Leaflet；**中文地图 Bing（默认, mkt=zh-CN）/ Google（hl=zh-CN）**，OSM/Esri 兜底；车辆位置 + 航向箭头 + 轨迹；Home 标记；**离线缓存（service worker + 缓存当前区域）**。
- **遥测**：飞行模式、武装状态、地速、航向、GPS 定位类型/卫星数、链路 RSSI、电压/电量、经纬度；**低电量蜂鸣告警**。
- **压航点 / 任务文件**：点图加点、拖动微调、删除；上传（完整 MISSION 握手）/ 下载 / 清空；**保存·读取 .waypoints**；**导入 KML 田块边界**。
- **发命令**：解锁/上锁、设置模式、RTL、启动任务(AUTO)、**急停**、**改速 (DO_CHANGE_SPEED)**、**暂停 (HOLD)**、**跳到航点**、Shift+点图引导前往(Goto)。
- **地理围栏**：画包含/排除多边形、上传（MAV_MISSION_TYPE_FENCE）、启用/停用（DO_FENCE_ENABLE）、**越界告警**（FENCE_STATUS）。
- **手柄/键盘遥控**：Gamepad API + 键盘（W/S=油门, A/D=转向, 空格=急停）→ RC_CHANNELS_OVERRIDE，MANUAL 模式应急驾驶/脱困。
- **操作员参数**：8 项 Rover 安全参数白名单读 / 写（PARAM_REQUEST_READ / PARAM_SET）。
- **遥测日志**：每会话 .tlog 记录（QGC / Mission Planner 兼容格式，存 `logs/`）。
- **日志**：飞控 STATUSTEXT（按严重度分色）、命令 ACK、链路事件。
- **内置仿真**：`sim/rover-sim.js` 行为级 ArduRover 仿真，无硬件即可端到端测试。

## 目录结构

```
web-gcs/
├── package.json
├── bridge/
│   ├── server.js     # 桥接 + 静态服务（核心）
│   ├── selftest.js   # node-mavlink API 自检 + 编解码闭环
│   └── itest.js      # 端到端集成测试（假飞控，13/13）
├── sim/
│   ├── rover-sim.js  # 行为级 ArduRover 仿真（UDP MAVLink，会真的开起来）
│   ├── simtest.js    # 全场景测试：围栏/任务/手柄遥控（8/8）
│   ├── sitltest.js   # 对真实 ArduPilot Rover SITL 的驾驶测试（8/8）
│   └── sitlprobe.js  # 快速探针：打印真实固件经桥接的遥测
├── scripts/
│   └── run-sitl.sh   # 启动真实固件 SITL 并转发 MAVLink 到 14550
└── public/
    ├── index.html
    ├── app.js        # 前端逻辑（WS / 地图 / 航点 / 命令 / 围栏 / 遥控）
    ├── style.css
    └── vendor/leaflet # 本地内置 Leaflet（离线可用）
```

## 桥接 WebSocket 协议（前后端约定，便于二次开发）

浏览器 → 桥接：`{t:'connect'|'disconnect'|'arm'|'mode'|'rtl'|'auto'|'pause'|'startMission'|'estop'|'goto'|'changeSpeed'|'setHome'|'setCurrent'|'uploadMission'|'downloadMission'|'getParams'|'setParam'|'tlogStart'|'tlogStop'|'uploadFence'|'fenceEnable'|'rc'|'rcRelease'}`
桥接 → 浏览器：`{t:'link'|'hb'|'pos'|'gps'|'sys'|'vfr'|'text'|'ack'|'home'|'mission_current'|'mission_reached'|'mission_uploaded'|'mission_list'|'fence_status'|'param'|'params_done'|'tlog'|'log'|'stale'|'snapshot'}`

## MVP 范围说明 / 后续

- 飞控固件：按需求只面向 **ArduPilot Rover（APM）**，MAVLink v2。
- 暂未含（下一批，见 `功能清单.md`）：避障/近距传感器可视化（已暂缓）、作业前检查单、圆形围栏、航测覆盖网格、视频、RTK/NTRIP 配置、桥接 Windows 安装包。
- 中国地图：用 Bing/Google 中文图。注意 Bing/Google 的中国**道路/标注**瓦片为 GCJ-02 偏移、**卫星**瓦片为 WGS-84；当前按既定方案**不做坐标纠偏**（用卫星图时车标与底图对齐，用道路图时可能有偏移）。
- 已知工程项：前端航点/参数列表部分用 innerHTML 渲染自身数值（非外部输入）；生产化时建议改 DOM 构造或加 CSP。
