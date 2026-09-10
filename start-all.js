const { spawn } = require('child_process');
const path = require('path');

console.log("=========================================");
console.log("🚀 Starting Dex Backend and Frontend...");
console.log("=========================================");
console.log("• Backend will run on:  http://localhost:8000");
console.log("• Frontend will run on: http://localhost:3000");
console.log("• Auth0 redirect:       DISABLED (Guest/Local mode active)");
console.log("=========================================\n");

const rootDir = __dirname;
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function startProcess(name, dir, args, color) {
  const proc = spawn(npmCmd, args, {
    cwd: path.join(rootDir, dir),
    shell: true,
    env: { ...process.env, BROWSER: 'none' } // don't hijack browser involuntarily
  });

  proc.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        console.log(`${color}[${name}]${'\x1b[0m'} ${line}`);
      }
    });
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        console.error(`${color}[${name}] (err)${'\x1b[0m'} ${line}`);
      }
    });
  });

  proc.on('close', (code) => {
    console.log(`${color}[${name}]${'\x1b[0m'} exited with code ${code}`);
  });

  return proc;
}

// Cyan for backend, Green for frontend
const backendProc = startProcess('BACKEND', 'backend', ['start'], '\x1b[36m');
const frontendProc = startProcess('FRONTEND', 'frontend', ['start'], '\x1b[32m');

function cleanup() {
  console.log("\nShutting down Dex servers...");
  if (isWin) {
    if (backendProc.pid) spawn('taskkill', ['/pid', backendProc.pid, '/f', '/t']);
    if (frontendProc.pid) spawn('taskkill', ['/pid', frontendProc.pid, '/f', '/t']);
  } else {
    backendProc.kill();
    frontendProc.kill();
  }
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
