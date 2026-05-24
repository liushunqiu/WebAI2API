/**
 * @fileoverview Supervisor 进程管理器
 * @description 负责管理 Xvfb 环境和子服务的生命周期
 *
 * 功能：
 * - Linux 环境下启动 xvfb-run
 * - 使用 child_process.spawn 启动 server.js
 * - 监听 IPC 通道接收重启指令
 * - 子进程崩溃时自动重启
 */

import { spawn, spawnSync } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';

// ==================== 配置 ====================

const isWindows = os.platform() === 'win32';

// IPC 通道路径
const IPC_PATH = isWindows
    ? '\\\\.\\pipe\\webai2api-supervisor'
    : path.join(os.tmpdir(), 'webai2api-supervisor.sock');

// 重启延迟（毫秒）
const RESTART_DELAY = 1000;

// 下次重启使用的参数（由 IPC 设置）
let restartArgs = null;

// ==================== 工具函数 ====================

/**
 * 简单日志
 * @param {string} level 
 * @param {string} message 
 */
function log(level, message) {
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
    const levelTag = level === 'ERROR' ? 'ERRO' : level;
    console.log(`${date} ${time} [${levelTag}] [看门狗] ${message}`);
}

/**
 * 检查命令是否存在（Linux）
 * @param {string} cmd 
 * @returns {boolean}
 */
function checkCommand(cmd) {
    if (isWindows) return true;
    const result = spawnSync('which', [cmd], { encoding: 'utf8' });
    return result.status === 0;
}

/**
 * 检查端口是否可用
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * 查找可用端口
 * @param {number} startPort - 起始端口
 * @param {number} maxTries - 最大尝试次数
 * @returns {Promise<number|null>}
 */
async function findAvailablePort(startPort, maxTries = 10) {
    for (let i = 0; i < maxTries; i++) {
        const port = startPort + i;
        if (await isPortAvailable(port)) {
            return port;
        }
    }
    return null;
}

/**
 * 检查 Xvfb 显示号是否可用
 * @param {number} displayNum 
 * @returns {boolean}
 */
function isDisplayAvailable(displayNum) {
    const lockFile = `/tmp/.X${displayNum}-lock`;
    const socketFile = `/tmp/.X11-unix/X${displayNum}`;
    return !fs.existsSync(lockFile) && !fs.existsSync(socketFile);
}

/**
 * 查找可用的显示号
 * @param {number} startNum - 起始显示号
 * @param {number} maxTries - 最大尝试次数
 * @returns {number}
 */
function findAvailableDisplay(startNum = 50, maxTries = 50) {
    for (let i = 0; i < maxTries; i++) {
        const num = startNum + i;
        if (isDisplayAvailable(num)) {
            return num;
        }
    }
    // 回退：使用随机显示号
    return 50 + Math.floor(Math.random() * 50);
}

// ==================== IPC 服务器 ====================

let serverProcess = null;
let isRestarting = false;

// VNC 状态追踪
let vncInfo = {
    enabled: false,
    port: 5900,
    display: ':99',
    xvfbMode: false
};

/**
 * 启动 IPC 服务器
 */
function startIpcServer() {
    // 清理旧的 socket 文件（Linux）
    if (!isWindows && fs.existsSync(IPC_PATH)) {
        try {
            fs.unlinkSync(IPC_PATH);
        } catch { }
    }

    const ipcServer = net.createServer((socket) => {
        socket.on('data', (data) => {
            const command = data.toString().trim();

            if (command === 'RESTART' || command.startsWith('RESTART:')) {
                // 支持 RESTART:参数 格式
                const extraArgs = command.includes(':') ? command.split(':')[1].split(' ').filter(Boolean) : [];
                log('INFO', `收到 IPC 指令: RESTART${extraArgs.length ? ' (参数: ' + extraArgs.join(' ') + ')' : ''}`);
                socket.write('OK\n');
                socket.end();
                restartServer(extraArgs);
            } else if (command === 'STOP') {
                log('INFO', '收到 IPC 指令: STOP');
                socket.write('OK\n');
                socket.end();
                stopAll();
            } else if (command === 'GET_VNC_INFO') {
                // 返回 VNC 状态信息并关闭连接
                socket.write(JSON.stringify(vncInfo) + '\n');
                socket.end();
            } else {
                socket.write('UNKNOWN_COMMAND\n');
                socket.end();
            }
        });
    });

    ipcServer.listen(IPC_PATH, () => {
        log('INFO', `IPC 服务器已启动: ${IPC_PATH}`);
    });

    ipcServer.on('error', (err) => {
        log('ERROR', `IPC 服务器错误: ${err.message}`);
    });

    return ipcServer;
}

// ==================== 子进程管理 ====================

// 不可恢复的退出码（不应自动重启）
const FATAL_EXIT_CODES = [
    78,  // 配置/依赖错误
];

/**
 * 启动 server.js 子进程
 * @param {string[]} [extraArgs] - 额外的命令行参数
 */
function startServer(extraArgs = []) {
    const serverPath = path.join(process.cwd(), 'src', 'server', 'server.js');

    // 检查 server.js 是否存在
    if (!fs.existsSync(serverPath)) {
        log('ERROR', `未找到 server.js: ${serverPath}`);
        process.exit(1);
    }

    const args = [serverPath, ...extraArgs];
    const env = {
        ...process.env,
        SUPERVISOR_IPC: IPC_PATH
    };

    log('INFO', '正在启动子服务 (src/server/server.js)...');

    serverProcess = spawn(process.execPath, args, {
        cwd: process.cwd(),
        env,
        stdio: 'inherit'  // 将子进程 stdio 直接输出到主控制台
    });

    serverProcess.on('exit', (code, signal) => {
        if (isRestarting) {
            log('INFO', '子服务已停止，准备重启...');
            isRestarting = false;
            // 如果有新参数，使用新参数；否则使用原参数
            const argsToUse = restartArgs !== null ? restartArgs : extraArgs;
            restartArgs = null; // 重置
            setTimeout(() => startServer(argsToUse), RESTART_DELAY);
        } else if (code !== 0 && code !== null) {
            // 检查是否为不可恢复的错误
            if (FATAL_EXIT_CODES.includes(code)) {
                log('ERROR', `子服务因配置/依赖错误退出 (code: ${code})，不会自动重启`);
                process.exit(code);
            }
            log('WARN', `子服务异常退出 (code: ${code})，将自动重启...`);
            setTimeout(() => startServer(extraArgs), RESTART_DELAY);
        } else {
            log('INFO', '子服务已正常退出');
            process.exit(0);
        }
    });

    serverProcess.on('error', (err) => {
        log('ERROR', `子服务启动失败: ${err.message}`);
        process.exit(1);
    });
}

/**
 * 重启子服务
 * @param {string[]} [newArgs] - 新的启动参数（将覆盖原有参数）
 */
function restartServer(newArgs = null) {
    if (isRestarting) {
        log('WARN', '重启已在进行中，忽略重复请求');
        return;
    }

    isRestarting = true;
    log('INFO', '正在重启子服务...');

    // 如果提供了新参数，更新启动参数
    if (newArgs !== null) {
        restartArgs = newArgs;
    }

    if (serverProcess) {
        serverProcess.kill('SIGTERM');
    }
}

/**
 * 停止所有服务
 */
function stopAll() {
    log('INFO', '正在停止所有服务...');

    if (serverProcess) {
        serverProcess.kill('SIGTERM');
    }

    setTimeout(() => process.exit(0), 500);
}

// ==================== Xvfb 处理（Linux） ====================

/**
 * 在 Xvfb 中启动
 * @param {string[]} originalArgs - 原始命令行参数
 */
function startInXvfb(originalArgs) {
    if (!checkCommand('xvfb-run')) {
        log('ERROR', '未找到 xvfb-run 命令');
        log('ERROR', '请先安装 Xvfb:');
        log('ERROR', ' - Ubuntu/Debian: sudo apt install xvfb');
        log('ERROR', ' - CentOS/RHEL:   sudo dnf install xorg-x11-server-Xvfb');
        process.exit(1);
    }

    // 查找可用的显示号（从 50 开始，避免与常用的冲突）
    const displayNum = findAvailableDisplay(50);
    log('INFO', `正在启动 Xvfb 虚拟显示器 (显示号: :${displayNum})...`);

    // 移除 -xvfb 参数
    const newArgs = originalArgs.filter(arg => arg !== '-xvfb');

    const xvfbArgs = [
        `--server-num=${displayNum}`,
        '--server-args=-ac -screen 0 1920x1080x24',
        'env',
        'XVFB_RUNNING=true',
        `DISPLAY=:${displayNum}`,
        process.argv[0],
        process.argv[1],
        ...newArgs
    ];

    const xvfbProcess = spawn('xvfb-run', xvfbArgs, {
        stdio: 'inherit'
    });

    xvfbProcess.on('error', (err) => {
        log('ERROR', `Xvfb 启动失败: ${err.message}`);
        process.exit(1);
    });

    xvfbProcess.on('exit', (code) => {
        process.exit(code || 0);
    });

    // 处理退出信号
    process.on('SIGINT', () => xvfbProcess.kill('SIGTERM'));
    process.on('SIGTERM', () => xvfbProcess.kill('SIGTERM'));
}

/**
 * 启动 VNC 服务器
 * @param {string} display - 显示器编号
 */
async function startVncServer(display) {
    if (!checkCommand('x11vnc')) {
        log('WARN', '未找到 x11vnc 命令，跳过 VNC 启动');
        return;
    }

    // 查找可用的 VNC 端口（从 5900 开始）
    const vncPort = await findAvailablePort(5900, 100);
    if (!vncPort) {
        log('ERROR', '无法找到可用的 VNC 端口 (5900-5999)');
        return;
    }

    log('INFO', `正在启动 VNC 服务器 (端口: ${vncPort})...`);

    const vncProcess = spawn('x11vnc', [
        '-display', display,
        '-rfbport', String(vncPort),
        '-localhost',
        '-nopw',
        '-shared',
        '-forever',
        '-noxdamage',
        '-norc',
        '-geometry', '1920x1080'
    ], {
        stdio: 'ignore',
        detached: false
    });

    vncProcess.on('error', (err) => {
        log('WARN', `VNC 启动失败: ${err.message}`);
        vncInfo.enabled = false;
    });

    vncProcess.on('exit', () => {
        vncInfo.enabled = false;
    });

    // 更新 VNC 状态
    vncInfo.enabled = true;
    vncInfo.port = vncPort;
    vncInfo.display = display;

    log('INFO', `VNC 服务器已启动，端口: ${vncPort}`);

    // 处理退出信号
    process.on('SIGINT', () => vncProcess.kill('SIGTERM'));
    process.on('SIGTERM', () => vncProcess.kill('SIGTERM'));
}

// ==================== 主入口 ====================

async function main() {
    const args = process.argv.slice(2);
    const hasXvfb = args.includes('-xvfb');
    const hasVnc = args.includes('-vnc');
    const isInXvfb = process.env.XVFB_RUNNING === 'true';
    const isLinux = os.platform() === 'linux';

    log('INFO', '主进程已启动');

    // 处理 Xvfb 参数（仅 Linux）
    if (hasXvfb && isLinux && !isInXvfb) {
        startInXvfb(args);
        return;
    }

    // 设置 xvfbMode 标识
    vncInfo.xvfbMode = isInXvfb;

    // 如果在 Xvfb 中运行，启动 VNC
    if (isInXvfb && hasVnc) {
        const display = process.env.DISPLAY || ':99';
        await startVncServer(display);
    }

    // 启动 IPC 服务器
    startIpcServer();

    // 启动子服务（过滤掉 -xvfb 和 -vnc 参数）
    const serverArgs = args.filter(arg => arg !== '-xvfb' && arg !== '-vnc');
    startServer(serverArgs);

    // 处理退出信号
    process.on('SIGINT', stopAll);
    process.on('SIGTERM', stopAll);
}

main().catch((err) => {
    log('ERROR', `启动失败: ${err.message}`);
    process.exit(1);
});
