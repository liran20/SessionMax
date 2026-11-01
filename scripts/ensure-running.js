// Run from Claude Code hooks (SessionStart, UserPromptSubmit, Stop, Notification):
// starts SessionMax if it isn't running. Must stay fast and never fail the hook.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pidFile = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'sessionmax', 'sessionmax.pid');
const launcher = path.join(__dirname, '..', 'SessionMax.vbs');

function running() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

try {
  if (!running()) {
    spawn('wscript.exe', [launcher], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
} catch {}
process.exit(0);
