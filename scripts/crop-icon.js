const sharp = require('sharp');
const path = require('path');

async function cropLogoIcon() {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'build', 'icon-clean.jpg');
  const out = path.join(root, 'public', 'app-icon');

  // 原图 2048x2048
  // 金色飞鸟中心约在 x:35%~65%, y:15%~55%
  // 整体圆角容器从约 x:4%~96%, y:4%~96%
  // 裁切策略：取整个圆角容器（去掉底部文字），保持正方形

  // 完整图标区域（去掉文字），大约 y:3% ~ 62%
  const cropY = Math.round(2048 * 0.02);
  const cropH = Math.round(2048 * 0.60);

  const cropped = await sharp(src)
    .extract({ left: 0, top: cropY, width: 2048, height: cropH })
    .toBuffer();

  // 把矩形变正方形：宽度是2048，高度是cropH(~1228)
  // 需要从左右裁掉一些，或者让sharp fit:cover处理
  const meta = await sharp(cropped).metadata();
  console.log('Cropped size:', meta.width, 'x', meta.height);

  // 用 contain 在正方形中（保持比例，不裁切）
  const result = await sharp(cropped)
    .resize(512, 512, { fit: 'cover', position: 'top' })
    .png()
    .toBuffer();

  await sharp(result).jpeg({ quality: 90 }).toFile(out + '.jpg');
  await sharp(result).png().toFile(out + '.png');

  console.log('app-icon.jpg + .png saved (512x512, cover, top center)');
}

cropLogoIcon().catch(e => console.error(e));
