const sharp = require('sharp');
const path = require('path');

async function generateAllIcons() {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'build', 'icon-clean.jpg');
  const publicDir = path.join(root, 'public');

  // 原图 2048x2048，圆角容器从约 4% 开始，"StoryForge" 文字从约 62% 开始
  // 裁掉文字，只保留图形区域
  const cropY = Math.round(2048 * 0.03);
  const cropH = Math.round(2048 * 0.58);

  const cropped = await sharp(src)
    .extract({ left: 0, top: cropY, width: 2048, height: cropH })
    .toBuffer();

  // 把矩形变正方形：取宽度的正方形居中
  const meta = await sharp(cropped).metadata();
  const side = Math.min(meta.width, meta.height);
  const offX = Math.round((meta.width - side) / 2);

  const squared = await sharp(cropped)
    .extract({ left: offX, top: 0, width: side, height: side })
    .resize(512, 512, { fit: 'cover' })
    .png()
    .toBuffer();

  await sharp(squared).jpeg({ quality: 90 }).toFile(path.join(publicDir, 'app-icon.jpg'));
  await sharp(squared).png().toFile(path.join(publicDir, 'app-icon.png'));

  console.log('Generated app-icon.jpg + .png (512x512, no text)');
}

generateAllIcons().catch(e => console.error(e));
