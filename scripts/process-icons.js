const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function processAll() {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'build', 'icon-source.jpg');
  const w = 2048, h = 2048;

  // 提取水印区域的背景色
  const { data, info } = await sharp(src)
    .extract({ left: 0, top: 1880, width: 2048, height: 40 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let rr = 0, gg = 0, bb = 0, cnt = 0;
  for (let x = 1717; x < 1977; x++) {
    const i = x * info.channels;
    rr += data[i]; gg += data[i+1]; bb += data[i+2]; cnt++;
  }
  rr = Math.round(rr/cnt); gg = Math.round(gg/cnt); bb = Math.round(bb/cnt);
  console.log('Fill color: RGB(' + rr + ',' + gg + ',' + bb + ')');

  // 覆盖水印
  const coverSvg = Buffer.from(
    '<svg width="2048" height="2048">' +
    '<rect x="1710" y="1905" width="350" height="85" rx="8" fill="rgb(' + rr + ',' + gg + ',' + bb + ')"/>' +
    '</svg>'
  );

  const cleaned = await sharp(src)
    .composite([{ input: coverSvg, blend: 'over' }])
    .png()
    .toBuffer();

  // 保存清洁版
  await sharp(cleaned).jpeg({ quality: 95 }).toFile(path.join(root, 'build', 'icon-clean.jpg'));
  console.log('build/icon-clean.jpg saved');

  // public/app-icon - 裁切核心图形（去掉文字+水印）
  const coreIcon = await sharp(cleaned)
    .extract({ left: 0, top: Math.round(h * 0.05), width: w, height: Math.round(h * 0.67) })
    .resize(512, 512, { fit: 'cover' })
    .toBuffer();

  await sharp(coreIcon).jpeg({ quality: 90 }).toFile(path.join(root, 'public', 'app-icon.jpg'));
  await sharp(coreIcon).png().toFile(path.join(root, 'public', 'app-icon.png'));
  console.log('public/app-icon.jpg + .png saved (core 512x512)');

  // build/icon.ico - 完整清洁版（含文字）
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of icoSizes) {
    const buf = await sharp(cleaned).resize(s, s, { fit: 'cover' }).png().toBuffer();
    pngs.push(buf);
  }

  const n = pngs.length;
  const dataStart = 6 + 16 * n;
  let totalData = pngs.reduce((sum, p) => sum + p.length, 0);
  const ico = Buffer.alloc(dataStart + totalData);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(n, 4);

  let offset = dataStart;
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const sz = icoSizes[i] >= 256 ? 0 : icoSizes[i];
    ico.writeUInt8(sz, e); ico.writeUInt8(sz, e + 1);
    ico.writeUInt8(0, e + 2); ico.writeUInt8(0, e + 3);
    ico.writeUInt16LE(1, e + 4); ico.writeUInt16LE(32, e + 6);
    ico.writeUInt32LE(pngs[i].length, e + 8);
    ico.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  }
  let pos = dataStart;
  pngs.forEach(p => { p.copy(ico, pos); pos += p.length; });

  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico);
  console.log('build/icon.ico saved (7 sizes)');

  // build/icon.png - 窗口图标
  await sharp(cleaned).resize(256, 256, { fit: 'cover' }).png().toFile(path.join(root, 'build', 'icon.png'));
  console.log('build/icon.png saved (256x256)');

  console.log('\nAll icons processed!');
}

processAll().catch(e => console.error(e));
