const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  // context.electronPlatformName, context.appOutDir, etc.
  if (context.electronPlatformName !== 'win32') return;

  // Find rcedit
  const cacheDir = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign');
  let rcedit = null;
  if (fs.existsSync(cacheDir)) {
    for (const sub of fs.readdirSync(cacheDir)) {
      const exe = path.join(cacheDir, sub, 'rcedit-x64.exe');
      if (fs.existsSync(exe)) { rcedit = exe; break; }
    }
  }
  if (!rcedit) {
    console.log('afterPack: rcedit not found, skipping icon');
    return;
  }

  const exePath = path.join(context.appOutDir, 'StoryForge AI.exe');
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');

  if (!fs.existsSync(exePath)) {
    console.log('afterPack: exe not found:', exePath);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.log('afterPack: icon not found:', iconPath);
    return;
  }

  console.log('afterPack: setting icon with rcedit...');
  try {
    execSync(`"${rcedit}" "${exePath}" --set-icon "${iconPath}"`, { stdio: 'inherit' });
    console.log('afterPack: icon set successfully!');
  } catch (e) {
    console.error('afterPack: failed to set icon:', e.message);
  }
};
