'use strict';
// Introspect node-mavlink API used by the bridge, and round-trip a heartbeat.
const {
  minimal, common, MavLinkProtocolV2, MavLinkPacketSplitter, MavLinkPacketParser, send,
} = require('node-mavlink');
const { Writable } = require('stream');

function fields(C) { try { return (C.FIELDS || []).map((f) => f.name).join(', '); } catch (e) { return 'ERR ' + e.message; } }
function msgid(C) { try { return C.MSG_ID; } catch (e) { return '?'; } }

const classes = {
  'minimal.Heartbeat': minimal.Heartbeat,
  'common.CommandLong': common.CommandLong,
  'common.CommandAck': common.CommandAck,
  'common.SetMode': common.SetMode,
  'common.GlobalPositionInt': common.GlobalPositionInt,
  'common.GpsRawInt': common.GpsRawInt,
  'common.SysStatus': common.SysStatus,
  'common.VfrHud': common.VfrHud,
  'common.Statustext': common.Statustext,
  'common.HomePosition': common.HomePosition,
  'common.MissionCount': common.MissionCount,
  'common.MissionRequestInt': common.MissionRequestInt,
  'common.MissionRequest': common.MissionRequest,
  'common.MissionItemInt': common.MissionItemInt,
  'common.MissionAck': common.MissionAck,
  'common.MissionCurrent': common.MissionCurrent,
  'common.MissionItemReached': common.MissionItemReached,
  'common.MissionRequestList': common.MissionRequestList,
  'common.RequestDataStream': common.RequestDataStream,
  'common.SetPositionTargetGlobalInt': common.SetPositionTargetGlobalInt,
};
console.log('--- MSG_ID + FIELDS ---');
for (const [name, C] of Object.entries(classes)) {
  console.log(`${name} [${msgid(C)}]: ${fields(C)}`);
}

console.log('\n--- enums ---');
const checks = [
  ['minimal.MavType.GCS', minimal.MavType && minimal.MavType.GCS],
  ['minimal.MavAutopilot.INVALID', minimal.MavAutopilot && minimal.MavAutopilot.INVALID],
  ['minimal.MavState.ACTIVE', minimal.MavState && minimal.MavState.ACTIVE],
  ['minimal.MavModeFlag.SAFETY_ARMED', minimal.MavModeFlag && minimal.MavModeFlag.SAFETY_ARMED],
  ['minimal.MavModeFlag.CUSTOM_MODE_ENABLED', minimal.MavModeFlag && minimal.MavModeFlag.CUSTOM_MODE_ENABLED],
  ['common.MavCmd.COMPONENT_ARM_DISARM', common.MavCmd && common.MavCmd.COMPONENT_ARM_DISARM],
  ['common.MavCmd.MISSION_START', common.MavCmd && common.MavCmd.MISSION_START],
  ['common.MavCmd.NAV_WAYPOINT', common.MavCmd && common.MavCmd.NAV_WAYPOINT],
  ['common.MavCmd.DO_SET_HOME', common.MavCmd && common.MavCmd.DO_SET_HOME],
  ['common.MavCmd.DO_SET_MISSION_CURRENT', common.MavCmd && common.MavCmd.DO_SET_MISSION_CURRENT],
  ['common.MavFrame.GLOBAL', common.MavFrame && common.MavFrame.GLOBAL],
  ['common.MavFrame.GLOBAL_RELATIVE_ALT', common.MavFrame && common.MavFrame.GLOBAL_RELATIVE_ALT],
  ['common.MavFrame.GLOBAL_RELATIVE_ALT_INT', common.MavFrame && common.MavFrame.GLOBAL_RELATIVE_ALT_INT],
  ['common.MavMissionType.MISSION', common.MavMissionType && common.MavMissionType.MISSION],
  ['common.MavMissionResult.MAV_MISSION_ACCEPTED', common.MavMissionResult && common.MavMissionResult.MAV_MISSION_ACCEPTED],
];
for (const [name, val] of checks) console.log(`${name} = ${val}`);

console.log('\n--- round-trip Heartbeat (serialize -> split -> parse) ---');
(async () => {
  const PROTOCOL = new MavLinkProtocolV2();
  PROTOCOL.sysid = 255; PROTOCOL.compid = 190;
  const splitter = new MavLinkPacketSplitter();
  const parser = new MavLinkPacketParser();
  splitter.pipe(parser);
  parser.on('data', (packet) => {
    const ok = packet.header.msgid === minimal.Heartbeat.MSG_ID;
    console.log('decoded msgid=' + packet.header.msgid + ' sysid=' + packet.header.sysid +
      ' compid=' + packet.header.compid + (ok ? '  ✓ heartbeat' : '  ✗'));
    const data = packet.protocol.data(packet.payload, minimal.Heartbeat);
    console.log('  type=' + data.type + ' autopilot=' + data.autopilot + ' customMode=' + data.customMode);
    process.exit(0);
  });
  const captor = new Writable({ write(chunk, _e, cb) { splitter.write(chunk); cb(); } });
  const hb = new minimal.Heartbeat();
  hb.type = minimal.MavType.GCS; hb.autopilot = minimal.MavAutopilot.INVALID;
  hb.baseMode = 0; hb.customMode = 0; hb.systemStatus = minimal.MavState.ACTIVE; hb.mavlinkVersion = 3;
  await send(captor, hb, PROTOCOL);
  setTimeout(() => { console.log('TIMEOUT: no packet decoded'); process.exit(1); }, 1500);
})();
