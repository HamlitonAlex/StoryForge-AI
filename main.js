const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 18080;
let mainWindow = null;

function migrateOldData() {
  const userDataPath = app.getPath('userData');
  const newDataDir = path.join(userDataPath, 'data');
  const oldDataDir = path.join(__dirname, 'data');

  // 只在新数据目录为空且旧数据目录存在时执行迁移
  if (!fs.existsSync(newDataDir) || fs.readdirSync(newDataDir).length === 0) {
    if (fs.existsSync(oldDataDir) && fs.readdirSync(oldDataDir).length > 0) {
      try {
        copyDirRecursive(oldDataDir, newDataDir);
        console.log('[迁移] 已从安装目录迁移数据到 AppData: ' + newDataDir);
      } catch(e) {
        console.error('[迁移] 数据迁移失败:', e.message);
      }
    }
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    process.env.DRAMA_STUDIO_PORT = PORT;
    // 数据目录 - 写到 AppData
    const userDataPath = app.getPath('userData');
    process.env.DRAMA_STUDIO_DATA = path.join(userDataPath, 'data');
    if (!fs.existsSync(process.env.DRAMA_STUDIO_DATA)) {
      fs.mkdirSync(process.env.DRAMA_STUDIO_DATA, { recursive: true });
    }
    // 执行旧数据迁移
    migrateOldData();
    try {
      require('./server.js');
    } catch(e) {
      reject(e);
      return;
    }
    resolve();
  });
}

function waitForServer(maxWait) {
  maxWait = maxWait || 20000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http.get('http://localhost:' + PORT + '/api/health', (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() - start > maxWait) {
          reject(new Error('Server startup timeout'));
        } else {
          setTimeout(check, 500);
        }
      });
    };
    check();
  });
}

function killPortProcess(port) {
  try {
    const { execSync } = require('child_process');
    const result = execSync('netstat -ano | findstr :' + port + ' | findstr LISTENING', { encoding: 'utf-8', timeout: 3000 });
    const lines = result.trim().split('\n');
    for (const line of lines) {
      const match = line.trim().match(/(\d+)$/);
      if (match) {
        const pid = parseInt(match[1]);
        if (pid > 0 && pid !== process.pid) {
          try { process.kill(pid); } catch(e) {}
        }
      }
    }
  } catch(e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'StoryForge AI',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#0f1012'
  });

  const serverUrl = 'http://localhost:' + PORT;
  mainWindow.loadURL(serverUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    setTimeout(() => {
      if (mainWindow) mainWindow.loadURL(serverUrl);
    }, 3000);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// ===== IPC: 文件夹选择和文件写入 =====
ipcMain.handle('select-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择工作文件夹'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '打开本地文件',
    filters: [
      { name: '所有支持文件', extensions: ['txt','md','json','js','ts','py','html','css','yaml','yml','xml','csv','log','jpg','jpeg','png','gif','svg','bmp','mp3','mp4','wav','pdf'] },
      { name: '文本文件', extensions: ['txt','md','json','js','ts','py','html','css','yaml','yml','xml','csv','log'] },
      { name: '图片文件', extensions: ['jpg','jpeg','png','gif','svg','bmp'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const ext = filePath.split('.').pop().toLowerCase();
    const imageExts = ['jpg','jpeg','png','gif','svg','bmp','webp'];
    if (imageExts.includes(ext)) {
      const data = fs.readFileSync(filePath);
      return { success: true, type: 'image', ext: ext, data: data.toString('base64'), path: filePath };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, type: 'text', content: content, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-file', async (event, { filePath, content }) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-image', async (event, { fileName, base64Data }) => {
  try {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, fileName);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-app-data-path', () => {
  return app.getPath('userData');
});

ipcMain.handle('delete-image', async (event, fileName) => {
  try {
    const userDataPath = app.getPath('userData');
    const filePath = path.join(userDataPath, fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-version', () => {
  try { return require('./package.json').version; } catch(e) { return '3.2.0'; }
});

const menu = Menu.buildFromTemplate([
  { label: '视图', submenu: [
    { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
    { label: '开发者工具', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.openDevTools() },
    { type: 'separator' },
    { role: 'zoomIn', label: '放大' },
    { role: 'zoomOut', label: '缩小' },
    { role: 'resetZoom', label: '重置缩放' }
  ]},
  { label: '帮助', submenu: [
    { label: '关于', click: () => dialog.showMessageBox(mainWindow, {
      type: 'info', title: '关于', message: 'StoryForge AI v3.1.1',
      detail: 'Mx-Shell x Mimo', buttons: ['确定']
    })}
  ]}
]);

app.whenReady().then(async () => {
  // 全局异常捕获，防止闪退
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
  });

  // 先清理端口
  killPortProcess(PORT);
  await new Promise(r => setTimeout(r, 500));

  await startServer();
  await waitForServer();
  Menu.setApplicationMenu(menu);
  createWindow();
}).catch(e => {
  dialog.showErrorBox('启动失败', 'StoryForge AI启动失败:\n' + e.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!mainWindow) createWindow(); });
