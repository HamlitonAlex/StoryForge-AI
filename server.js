const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.DRAMA_STUDIO_PORT) || 3003;

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

const BASE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, 'Desktop', '智能体搭建', 'AI短剧创作系统');
const SKILLS_DIR = path.join(__dirname, 'skills');
const DATA_DIR = process.env.DRAMA_STUDIO_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* 全局异常捕获，防止进程崩溃 */
process.on('uncaughtException', (err) => { console.error('[SERVER] Uncaught:', err.message || err); });
process.on('unhandledRejection', (reason) => { console.error('[SERVER] Unhandled rejection:', reason); });

[BASE_DIR, SKILLS_DIR, DATA_DIR, PUBLIC_DIR,
 path.join(BASE_DIR, 'projects'),
 path.join(BASE_DIR, 'assets'),
 path.join(BASE_DIR, 'assets', '分镜关键帧'),
 path.join(DATA_DIR, 'messages'),
 path.join(DATA_DIR, 'uploads')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ==================== Config ====================
const DEFAULT_CONFIG = {
  llm_base_url: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
  api_key: 'tp-c5x3ykq8jrpbiui3ks4iosvtb7bcueitddrw793p5ukyjk73',
  model: 'mimo-v2.5-pro',
  temperature: 0.7,
  context_limit: 200000,
  reserved_output_tokens: 32000,
  auto_clear_context: true,
  use_anthropic_format: false,
  image_api_url: 'http://localhost:3000/api/online-image',
  image_model: 'gpt-image-2',
  is_dark_mode: true
};

function loadConfig() {
  var fp = path.join(DATA_DIR, 'config.json');
  var cfg = { ...DEFAULT_CONFIG };
  try {
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(fp, 'utf-8')) };
  } catch(e) {}
  // 合并 providers 到 config
  var pp = path.join(DATA_DIR, 'providers.json');
  try {
    var providers = JSON.parse(fs.readFileSync(pp, 'utf-8'));
    cfg.api_providers = providers;
  } catch (e) { cfg.api_providers = []; }
  // 兼容前端字段名
  cfg.model_name = cfg.model_name || cfg.model;
  cfg.api_base = cfg.api_base || cfg.llm_base_url;
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
}

// ==================== Conversations ====================
function loadConversations() {
  const p = path.join(DATA_DIR, 'conversations.json');
  if (fs.existsSync(p)) {
    try {
      const list = JSON.parse(fs.readFileSync(p, 'utf-8'));
      // 过滤掉没有消息文件的对话（保留有消息文件的空对话）
      const filtered = list.filter(c => {
        const fp = path.join(DATA_DIR, 'messages', `${c.id}.json`);
        return fs.existsSync(fp);
      });
      // 清理：如果过滤后数量变了，说明有空对话，更新文件
      if (filtered.length !== list.length) {
        try { saveConversations(filtered); } catch(e) {}
      }
      return filtered;
    } catch(e) {}
  }
  return [];
}

function saveConversations(list) {
  fs.writeFileSync(path.join(DATA_DIR, 'conversations.json'), JSON.stringify(list, null, 2), 'utf-8');
}

function loadMessages(convId) {
  const fp = path.join(DATA_DIR, 'messages', `${convId}.json`);
  if (fs.existsSync(fp)) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch(e) {}
  }
  return [];
}

function saveMessages(convId, msgs) {
  const dir = path.join(DATA_DIR, 'messages');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${convId}.json`), JSON.stringify(msgs, null, 2), 'utf-8');
}

// ==================== Projects ====================
function loadProjects() {
  const p = path.join(DATA_DIR, 'projects.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e) {}
  }
  return [];
}

function saveProjects(list) {
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(list, null, 2), 'utf-8');
}

function genId() {
  return Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

// ==================== Skills ====================
function loadSkills() {
  const skills = [];
  const disabledSkills = loadDisabledSkills();
  if (!fs.existsSync(SKILLS_DIR)) return skills;
  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const skillPath = path.join(SKILLS_DIR, d.name, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const raw = fs.readFileSync(skillPath, 'utf-8');
      const fm = parseFrontmatter(raw);
      skills.push({
        id: d.name,
        name: fm.name || d.name,
        description: fm.description || '',
        output_description: fm.output_description || '',
        content: fm.body || raw,
        dir: d.name,
        enabled: !disabledSkills.includes(d.name)
      });
    }
  }
  return skills;
}

function loadDisabledSkills() {
  const p = path.join(DATA_DIR, 'disabled_skills.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch(e) {}
  }
  return [];
}

function saveDisabledSkills(list) {
  fs.writeFileSync(path.join(DATA_DIR, 'disabled_skills.json'), JSON.stringify(list, null, 2), 'utf-8');
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { name: '', description: '', output_description: '', body: raw };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return { name: meta.name || '', description: meta.description || '', output_description: meta.output_description || '', body: m[2].trim() };
}

// ==================== LLM API ====================
function callLLM(messages, config, stream = true) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.llm_base_url);
    const body = JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.reserved_output_tokens || 32000,
      stream
    });
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 180000 // 3分钟请求超时
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(opts, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error(`LLM API ${res.statusCode}: ${errBody.slice(0, 500)}`)));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM API 请求超时，请重试')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Extract text content from uploaded files
function extractFileContent(files) {
  if (!files || !Array.isArray(files) || files.length === 0) return '';
  var parts = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var filePath = path.join(DATA_DIR, 'uploads', f.savedName || path.basename(f.url || ''));
    if (!fs.existsSync(filePath)) continue;
    var ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === '.txt' || ext === '.md') {
        var text = fs.readFileSync(filePath, 'utf-8').slice(0, 8000);
        parts.push('--- 文件 [' + f.name + '] ---\n' + text + '\n---');
      } else if (ext === '.pdf') {
        // Simple PDF text extraction - read raw bytes and extract text between markers
        var buf = fs.readFileSync(filePath);
        var raw = buf.toString('latin1');
        // Extract text streams from PDF
        var textParts = [];
        var streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
        var match;
        while ((match = streamRegex.exec(raw)) !== null) {
          var streamData = match[1];
          // Decompress if FlateDecode
          try {
            if (streamData.indexOf('FlateDecode') !== -1 || raw.indexOf('/FlateDecode') !== -1) {
              var zlib = require('zlib');
              var compressed = Buffer.from(streamData, 'binary');
              try {
                var decompressed = zlib.inflateSync(compressed);
                var decompressedStr = decompressed.toString('utf-8');
                // Extract text between BT and ET markers
                var btRegex = /BT\s*([\s\S]*?)\s*ET/g;
                var btMatch;
                while ((btMatch = btRegex.exec(decompressedStr)) !== null) {
                  var textContent = btMatch[1].replace(/\([^)]*\)/g, function(m) {
                    // Decode PDF string escapes
                    return m.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
                  });
                  if (textContent.trim()) textParts.push(textContent.trim());
                }
                // Also try TJ array
                var tjRegex = /\[([^\]]*)\]/g;
                var tjMatch;
                while ((tjMatch = tjRegex.exec(decompressedStr)) !== null) {
                  var items = tjMatch[1];
                  var charRegex = /\(([^)]*)\)/g;
                  var chars = '';
                  var cm;
                  while ((cm = charRegex.exec(items)) !== null) {
                    chars += cm[1].replace(/\\n/g, '\n').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
                  }
                  if (chars.trim()) textParts.push(chars.trim());
                }
              } catch(e) {}
            }
          } catch(e) {}
          if (textParts.length === 0) {
            // Fallback: try to find any readable text in the stream
            var readable = streamData.replace(/[^\x20-\x7E\n\r\t\u4e00-\u9fff]/g, ' ');
            if (readable.trim().length > 20) textParts.push(readable.trim().slice(0, 8000));
          }
        }
        if (textParts.length > 0) {
          parts.push('--- PDF [' + f.name + '] ---\n' + textParts.join('\n').slice(0, 8000) + '\n---');
        }
      } else if (ext === '.doc' || ext === '.docx') {
        // For .docx files, they are ZIP archives. Extract document.xml
        try {
          var AdmZip = require('adm-zip');
          var zip = new AdmZip(filePath);
          var docXml = zip.readAsText('word/document.xml');
          // Extract text from <w:t> tags
          var textContent = '';
          var tagRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
          var tagMatch;
          while ((tagMatch = tagRegex.exec(docXml)) !== null) {
            textContent += tagMatch[1];
          }
          if (textContent.trim()) {
            parts.push('--- Word文档 [' + f.name + '] ---\n' + textContent.slice(0, 8000) + '\n---');
          }
        } catch(e) {
          // adm-zip not available, try as plain text fallback
          try {
            var buf = fs.readFileSync(filePath);
            // .docx is a ZIP, try to find XML content
            var raw = buf.toString('utf-8');
            var tagRegex2 = /<w:t[^>]*>([^<]*)<\/w:t>/g;
            var textContent2 = '';
            var tm2;
            while ((tm2 = tagRegex2.exec(raw)) !== null) {
              textContent2 += tm2[1];
            }
            if (textContent2.trim()) {
              parts.push('--- Word文档 [' + f.name + '] ---\n' + textContent2.slice(0, 8000) + '\n---');
            }
          } catch(e2) {
            parts.push('--- 文件 [' + f.name + '] ---\n[无法提取内容，格式不受支持]\n---');
          }
        }
      }
    } catch(e) {
      parts.push('--- 文件 [' + f.name + '] ---\n[读取失败: ' + e.message + ']\n---');
    }
  }
  return parts.join('\n\n');
}

// Convert uploaded image files to base64 data URLs for vision API
function extractImageFiles(files) {
  if (!files || !Array.isArray(files)) return [];
  var images = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f.type || !f.type.startsWith('image/')) continue;
    var filePath = path.join(DATA_DIR, 'uploads', f.savedName || path.basename(f.url || ''));
    if (!fs.existsSync(filePath)) continue;
    try {
      var buf = fs.readFileSync(filePath);
      var base64 = buf.toString('base64');
      images.push({ url: 'data:' + f.type + ';base64,' + base64, name: f.name });
    } catch(e) {}
  }
  return images;
}

async function agentChat(userMessage, conversationId, history, files, config, selectedSkills) {
  let systemPrompt = `你是"StoryForge AI"的专业剧本创作助手。你的核心职责是**引导式创作**——通过主动提问来帮助用户完善剧本。

## 核心原则：引导式生成

**你必须在对话中主动提问**，而不是直接给出完整剧本。每次回复时，你应该：

1. 先理解用户当前的需求和进度
2. 主动询问缺失的关键信息
3. 根据用户回答逐步完善创作

## 引导流程（必须遵循）

当用户第一次提出创作需求时，按以下顺序提问：

### 第一轮：基本信息
- 故事类型（古风/现代/科幻/悬疑/甜宠/虐恋/喜剧/动作/奇幻）
- 目标平台（抖音/快手/B站/小红书/YouTube Shorts）
- 视频时长（15秒/30秒/1分钟/3分钟/5分钟以上）

### 第二轮：角色设定
- 主角数量和性别
- 主角年龄段（少年/青年/中年/老年）
- 主角外貌特征（发型/服装/气质）
- 配角设定

### 第三轮：故事框架
- 故事背景（古代/现代/未来/架空世界）
- 核心冲突（误会/阴谋/爱情/复仇/成长/冒险）
- 情感基调（甜蜜/虐心/搞笑/热血/悬疑/治愈）
- 故事走向（HE/BE/开放式）

### 第四轮：视觉风格
- 画面风格（写实/动漫/水墨/赛博朋克/复古/童话）
- 色彩基调（暖色调/冷色调/高饱和/低饱和/黑白）
- 参考作品（可以问用户是否有喜欢的影视/动漫风格）

### 第五轮：分镜细节
- 每个场景的描述
- 镜头语言（特写/全景/跟拍/航拍）
- 配乐风格

## 提问方式

使用 \`question\` 工具来提问。每次只问1-2个问题，不要一次问太多。选项要具体明确。

例如：
[TOOL_CALL]{"name":"question","args":{"question":"你想创作什么类型的故事？","options":["古风仙侠","现代都市","科幻未来","悬疑推理","甜宠恋爱","搞笑喜剧"]}}[/TOOL_CALL]

[TOOL_CALL]{"name":"question","args":{"question":"目标发布平台是？","options":["抖音（竖屏9:16）","快手（竖屏9:16）","B站（横屏16:9）","小红书（方形1:1）","YouTube Shorts（竖屏9:16）"]}}[/TOOL_CALL]

## 回复风格

- 语言亲切自然，像朋友聊天
- 每次回复简洁有力，不要长篇大论
- 在提问前，先对用户已提供的信息做简短确认
- 当信息收集足够时，主动说"好的，我已经了解了，现在开始为你创作剧本"

## 专业能力

你精通：
- 短剧剧本结构（起承转合、钩子设计、反转技巧）
- AI视频提示词编写（适用于Sora/Runway/Kling/Seedance等）
- 分镜脚本设计（镜头语言、画面描述、时长分配）
- 角色设定和人物弧光
- 平台算法优化（完播率、互动率）`;


  systemPrompt += `
## 语言规范
- 回复中不要使用任何emoji表情符号
- 不要使用星星、箭头、勾号等装饰性unicode符号
- 使用纯文字排版，用 markdown 格式（如**加粗**、- 列表、### 标题）来组织内容
- 保持专业简洁的文字风格

## 提示词生成规范（图片/视频场景）
当用户需要生成图片或视频的场景提示词时，你必须先询问以下摄影参数（如果用户未明确指定）：
1. **镜头角度**：平视/仰拍/俯拍/鸟瞰/低角度/高角度/荷兰角（倾斜）
2. **焦段**：14mm超广角/24mm广角/35mm标准广角/50mm标准/85mm人像/135mm中长焦/200mm长焦/400mm超长焦
3. **光圈**：f/1.4大光圈浅景深 / f/2.8 / f/5.6 / f/8中等 / f/11小光圈深景深 / f/16极深景深
4. **光线类型**：自然光/逆光/侧光/顶光/伦勃朗光/蝴蝶光/分割光/硬光/软光/丁达尔效应/霓虹光/烛光/火光
5. **色调**：冷调/暖调/黑白/赛博朋克霓虹/复古胶片/高饱和/低饱和/电影级调色
6. **拍摄设备模拟**（可选）：ARRI Alexa / RED Komodo / Sony VENICE / Hasselblad / Leica / Canon EOS / Nikon Z

询问时使用 question 工具让用户以按钮形式选择，每个参数提供3-5个常用选项。用户选择后，将这些参数融入最终提示词。
`;

  // 加载技能：仅加载用户明确选择的技能，不再自动加载全部
  let skills = [];
  if (selectedSkills && Array.isArray(selectedSkills) && selectedSkills.length > 0) {
    const allSkills = loadSkills();
    skills = allSkills.filter(s =>
      selectedSkills.includes(s.name) ||
      selectedSkills.includes(s.id) ||
      selectedSkills.includes(s.dir)
    );
  }
  if (skills.length > 0) {
    systemPrompt += '\n\n## 已加载技能库\n';
    systemPrompt += '你已经掌握了以下Mx-Shell提示词模板体系的所有技能。根据用户的请求，自动选择最合适的技能来执行任务。不要询问用户使用哪个技能，直接使用最匹配的技能。\n';
    for (const skill of skills) {
      systemPrompt += `\n### 技能: ${skill.name}\n${skill.description}\n\n技能内容:\n${skill.content}\n`;
    }
  }

  // 加载当前对话的项目上下文
  if (conversationId) {
    const conv = loadConversations().find(c => c.id === conversationId);
    if (conv && conv.project_id) {
      const projDir = path.join(BASE_DIR, 'projects', conv.project_id);
      const contextFiles = ['角色.md', '分镜.md', '剧本.md', '提示词.md', '片段提示词.md', '全部提示词.md'];
      for (const f of contextFiles) {
        const fp = path.join(projDir, f);
        if (fs.existsSync(fp)) {
          const content = fs.readFileSync(fp, 'utf-8').slice(0, 3000);
          systemPrompt += `\n\n--- 项目文件 [${f}] ---\n${content}\n---`;
        }
      }
    }
  }

  systemPrompt += `

## 可用工具

当你需要执行操作时，请使用以下格式输出工具调用（独占一行）：

[TOOL_CALL]{"name":"工具名","args":{"参数名":"参数值"}}[/TOOL_CALL]

可用工具：
1. save_file - 保存文件到项目
   args: {"project_id":"项目ID","filename":"文件名","content":"内容"}
2. read_file - 读取项目文件
   args: {"project_id":"项目ID","filename":"文件名"}
3. list_files - 列出项目文件
   args: {"project_id":"项目ID"}
4. generate_image - 生成图片
   args: {"prompt":"图片提示词","size":"1024x1024或1792x1024"}
5. create_project - 创建新项目
   args: {"name":"项目名","description":"描述"}
6. question - 向用户确认
   args: {"question":"确认问题","options":["选项1","选项2"]}

注意：一次回复中可以包含多个工具调用。先输出内容给用户看，再调用工具保存。`;

  const messages = [{ role: 'system', content: systemPrompt }];
  if (history && Array.isArray(history)) {
    history.forEach(h => {
      // Check if this history message has image attachments (for vision)
      var images = extractImageFiles(h.files);
      if (images.length > 0) {
        // Use multi-modal content format for vision API
        var contentParts = [];
        for (var img of images) {
          contentParts.push({ type: 'image_url', image_url: { url: img.url } });
        }
        if (h.content) contentParts.push({ type: 'text', text: h.content });
        messages.push({ role: h.role, content: contentParts });
      } else {
        messages.push({ role: h.role, content: h.content });
      }
    });
  }

  // Process current user message attachments
  var currentFiles = files || [];
  var currentImages = extractImageFiles(currentFiles);
  var docContent = extractFileContent(currentFiles);

  if (currentImages.length > 0 || docContent) {
    var userContentParts = [];
    for (var img of currentImages) {
      userContentParts.push({ type: 'image_url', image_url: { url: img.url } });
    }
    var textContent = userMessage;
    if (docContent) textContent += '\n\n' + docContent;
    if (textContent) userContentParts.push({ type: 'text', text: textContent });
    messages.push({ role: 'user', content: userContentParts });
  } else {
    messages.push({ role: 'user', content: userMessage });
  }

  // 如果消息中包含图片附件且当前模型不支持vision，自动切换到支持的模型
  var effectiveConfig = { ...config };
  var hasImages = currentImages.length > 0;
  if (!hasImages) {
    // 检查历史消息中是否包含图片
    for (var hi = 0; hi < messages.length; hi++) {
      var mContent = messages[hi].content;
      if (Array.isArray(mContent)) {
        for (var ci = 0; ci < mContent.length; ci++) {
          if (mContent[ci].type === 'image_url') { hasImages = true; break; }
        }
      }
      if (hasImages) break;
    }
  }
  if (hasImages) {
    const visionModels = ['mimo-v2.5', 'gpt-4o', 'gpt-4-vision-preview', 'qwen-vl-max', 'qwen-vl-plus', 'claude-3-5-sonnet', 'claude-3-opus'];
    const currentModel = (config.model || '').toLowerCase();
    const isVisionCapable = visionModels.some(vm => vm.toLowerCase() === currentModel);
    if (!isVisionCapable && currentModel.includes('mimo')) {
      effectiveConfig.model = 'mimo-v2.5';
    }
  }

  return await callLLM(messages, effectiveConfig, true);
}

// ==================== Tool Execution ====================
function extractToolCalls(text) {
  const regex = /\[TOOL_CALL\](\{[\s\S]*?\})\[\/TOOL_CALL\]/g;
  const calls = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    try { calls.push(JSON.parse(m[1])); } catch(e) {}
  }
  return calls;
}

async function executeToolCalls(calls, config) {
  const results = [];
  for (const call of calls) {
    try {
      let result;
      switch (call.name) {
        case 'save_file': {
          const projDir = path.join(BASE_DIR, 'projects', call.args.project_id);
          if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
          fs.writeFileSync(path.join(projDir, call.args.filename), call.args.content || '', 'utf-8');
          result = { ok: true, message: `文件已保存: ${call.args.filename}` };
          break;
        }
        case 'read_file': {
          const fp = path.join(BASE_DIR, 'projects', call.args.project_id, call.args.filename);
          if (fs.existsSync(fp)) {
            result = { ok: true, content: fs.readFileSync(fp, 'utf-8') };
          } else {
            result = { ok: false, message: '文件不存在' };
          }
          break;
        }
        case 'list_files': {
          const projDir = path.join(BASE_DIR, 'projects', call.args.project_id);
          if (fs.existsSync(projDir)) {
            result = { ok: true, files: fs.readdirSync(projDir).filter(f => !f.startsWith('.')) };
          } else {
            result = { ok: true, files: [] };
          }
          break;
        }
        case 'generate_image': {
          const imgResult = await generateImage(call.args.prompt, call.args.size || '1024x1024', config);
          result = { ok: true, message: '图片已生成', image: imgResult };
          break;
        }
        case 'create_project': {
          const projects = loadProjects();
          const id = genId();
          const proj = {
            id, name: call.args.name || '新项目',
            description: call.args.description || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          projects.push(proj);
          saveProjects(projects);
          const projDir = path.join(BASE_DIR, 'projects', id);
          [projDir, path.join(projDir, 'assets')].forEach(d => {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
          });
          result = { ok: true, project: proj };
          break;
        }
        case 'question':
          /* question工具不在服务端执行，仅返回确认 */
          result = { ok: true, message: '已发送问题给用户', question: call.args.question, options: call.args.options };
          break;
        default:
          result = { ok: false, message: `未知工具: ${call.name}` };
      }
      results.push({ name: call.name, args: call.args, result });
    } catch(e) {
      results.push({ name: call.name, args: call.args, result: { ok: false, message: e.message } });
    }
  }
  return results;
}

function generateImage(prompt, size, config) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.image_api_url || 'http://localhost:3000/api/online-image');
    const body = JSON.stringify({ prompt, provider_id: 'api', model: config.image_model || 'gpt-image-2', size, quality: 'high' });
    const opts = {
      hostname: url.hostname, port: url.port || 80, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const proto = url.protocol === 'https:' ? https : http;
    const req = proto.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.images && parsed.images.length > 0) resolve({ url: parsed.images[0], type: 'path' });
          else if (parsed.image) resolve({ url: parsed.image, type: 'base64' });
          else reject(new Error('No image in response'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ==================== HTTP Server ====================
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 500) { json(res, { error: msg }, status); }

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // === Static ===
    if (pathname === '/' || pathname === '/index.html') {
      const fp = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(fp)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(fp).pipe(res); }
      else err(res, 'Not found', 404);
      return;
    }

    // === Serve any file from public directory ===
    if (!pathname.startsWith('/api/')) {
      const publicFile = path.join(PUBLIC_DIR, pathname);
      if (fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) {
        const ext = path.extname(publicFile);
        const contentType = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(publicFile).pipe(res);
        return;
      }
    }

    // === API ===
    if (pathname === '/api/health') return json(res, { status: 'ok', time: new Date().toISOString() });

    // --- Config ---
    if (pathname === '/api/config') {
      if (req.method === 'GET') return json(res, loadConfig());
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const cfg = { ...loadConfig(), ...body };
        saveConfig(cfg);
        return json(res, cfg);
      }
    }
    if (pathname === '/api/config/token' && req.method === 'GET') {
      const cfg = loadConfig();
      const providers = cfg.api_providers || [];
      const msProvider = providers.find(p => p.id === 'modelscope' || p.name === 'ModelScope');
      return json(res, { token: msProvider ? (msProvider.key || msProvider.api_key || '') : '' });
    }

    // --- Skills ---
    if (pathname === '/api/skills' && req.method === 'GET') {
      return json(res, loadSkills().map(s => ({ id: s.id, name: s.name, description: s.description, output_description: s.output_description, dir: s.dir, enabled: s.enabled })));
    }
    // --- Skill Import (must be before skillMatch regex) ---
    if (pathname === '/api/skills/import' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.name || !body.content) return err(res, '缺少 name 或 content 字段', 400);
      const skillId = body.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '_');
      const skillDir = path.join(SKILLS_DIR, skillId);
      if (fs.existsSync(skillDir)) return err(res, `技能目录 ${skillId} 已存在`, 409);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body.content, 'utf-8');
      return json(res, { ok: true, id: skillId, message: `技能 ${body.name} 导入成功` });
    }
    const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (skillMatch) {
      const id = decodeURIComponent(skillMatch[1]);
      const skills = loadSkills();
      const normalizedId = id.replace(/-/g, '_');
      const skill = skills.find(s => s.id === id || s.dir === id || s.id === normalizedId || s.dir === normalizedId);
      if (!skill) return err(res, 'Not found', 404);
      if (req.method === 'GET') return json(res, { id: skill.id, name: skill.name, description: skill.description, content: skill.content, dir: skill.dir, enabled: skill.enabled });
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        const disabled = loadDisabledSkills();
        if (body.enabled === false && !disabled.includes(id)) { disabled.push(id); saveDisabledSkills(disabled); }
        if (body.enabled === true && disabled.includes(id)) { saveDisabledSkills(disabled.filter(d => d !== id)); }
        return json(res, { ok: true, enabled: body.enabled });
      }
      if (req.method === 'DELETE') {
        const skillDir = path.join(SKILLS_DIR, id);
        if (fs.existsSync(skillDir)) {
          fs.rmSync(skillDir, { recursive: true, force: true });
        }
        // 从 disabled_skills.json 中移除
        const disabled = loadDisabledSkills().filter(d => d !== id);
        saveDisabledSkills(disabled);
        return json(res, { ok: true, message: `技能 ${id} 已删除` });
      }
    }

    // --- Conversations ---
    if (pathname === '/api/conversations') {
      if (req.method === 'GET') return json(res, loadConversations());
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const convs = loadConversations();
        const conv = {
          id: genId(), title: body.title || '新对话',
          full_title: body.full_title || body.title || '新对话',
          project_id: body.project_id || null,
          pinned: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        convs.unshift(conv);
        saveConversations(convs);
        // 初始化空消息文件，避免被 loadConversations 过滤掉
        const msgFp = path.join(DATA_DIR, 'messages', `${conv.id}.json`);
        fs.writeFileSync(msgFp, '[]', 'utf-8');
        return json(res, conv);
      }
    }
    const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      const id = convMatch[1];
      if (req.method === 'GET') {
        const msgs = loadMessages(id);
        return json(res, { messages: msgs });
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        const convs = loadConversations();
        const conv = convs.find(c => c.id === id);
        if (conv) { Object.assign(conv, body, { updated_at: new Date().toISOString() }); saveConversations(convs); }
        return json(res, { ok: true });
      }
      if (req.method === 'DELETE') {
        saveConversations(loadConversations().filter(c => c.id !== id));
        const fp = path.join(DATA_DIR, 'messages', `${id}.json`);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        return json(res, { ok: true });
      }
    }

    // --- 保存对话消息 ---
    const msgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (msgMatch && req.method === 'POST') {
      const id = msgMatch[1];
      const body = JSON.parse(await readBody(req));
      saveMessages(id, body.messages || []);
      return json(res, { ok: true });
    }

    // --- Projects ---
    if (pathname === '/api/projects') {
      if (req.method === 'GET') return json(res, loadProjects());
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const projects = loadProjects();
        const id = genId();
        const proj = { id, name: body.name || '新项目', description: body.description || '', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        projects.push(proj);
        saveProjects(projects);
        const projDir = path.join(BASE_DIR, 'projects', id);
        [projDir, path.join(projDir, 'assets')].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
        return json(res, proj);
      }
    }
    const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch) {
      const id = projMatch[1];
      if (req.method === 'GET') {
        const projects = loadProjects();
        const proj = projects.find(p => p.id === id);
        if (!proj) return err(res, 'Not found', 404);
        const projDir = path.join(BASE_DIR, 'projects', id);
        let files = [];
        if (fs.existsSync(projDir)) files = fs.readdirSync(projDir).filter(f => !f.startsWith('.'));
        return json(res, { ...proj, files });
      }
      if (req.method === 'DELETE') {
        saveProjects(loadProjects().filter(p => p.id !== id));
        return json(res, { ok: true });
      }
    }
    const fileMatch = pathname.match(/^\/api\/projects\/([^/]+)\/files\/(.+)$/);
    if (fileMatch) {
      const id = fileMatch[1], filename = decodeURIComponent(fileMatch[2]);
      const filePath = path.join(BASE_DIR, 'projects', id, filename);
      const projDir = path.join(BASE_DIR, 'projects', id);
      if (!filePath.startsWith(projDir)) return err(res, 'Invalid path', 403);
      if (req.method === 'GET') {
        if (!fs.existsSync(filePath)) return json(res, { content: '' });
        return json(res, { content: fs.readFileSync(filePath, 'utf-8'), filename });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, body.content || '', 'utf-8');
        return json(res, { ok: true, filename });
      }
    }

    // --- Assets ---
    if (pathname === '/api/assets' && req.method === 'GET') {
      const result = [];
      const scan = (dir, prefix) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(f => {
          const fp = path.join(dir, f);
          if (fs.statSync(fp).isDirectory()) { scan(fp, prefix + f + '/'); }
          else if (/\.(png|jpg|jpeg|gif|webp)$/i.test(f)) {
            const stat = fs.statSync(fp);
            result.push({ name: f, path: prefix + f, size: stat.size, modified: stat.mtime, dir: prefix.slice(0, -1) || 'assets' });
          }
        });
      };
      scan(path.join(BASE_DIR, 'assets'), '');
      return json(res, result);
    }

    // --- Asset Delete ---
    const assetMatch = pathname.match(/^\/api\/assets\/(.+)$/);
    if (assetMatch) {
      const filename = decodeURIComponent(assetMatch[1]);
      const assetsDirs = [
        path.join(BASE_DIR, 'assets'),
        path.join(BASE_DIR, 'assets', '分镜关键帧')
      ];
      if (req.method === 'DELETE') {
        let deleted = false;
        for (const dir of assetsDirs) {
          const fp = path.join(dir, filename);
          // 安全检查：确保路径不会跳出assets目录
          if (!fp.startsWith(path.join(BASE_DIR, 'assets'))) continue;
          if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            fs.unlinkSync(fp);
            deleted = true;
          }
        }
        if (!deleted) return err(res, '文件不存在', 404);
        return json(res, { ok: true, message: `文件 ${filename} 已删除` });
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        if (!body.new_name) return err(res, '缺少 new_name 字段', 400);
        let renamed = false;
        for (const dir of assetsDirs) {
          const oldPath = path.join(dir, filename);
          if (!oldPath.startsWith(path.join(BASE_DIR, 'assets'))) continue;
          if (fs.existsSync(oldPath) && fs.statSync(oldPath).isFile()) {
            const newPath = path.join(dir, body.new_name);
            if (!newPath.startsWith(path.join(BASE_DIR, 'assets'))) continue;
            fs.renameSync(oldPath, newPath);
            renamed = true;
            break;
          }
        }
        if (!renamed) return err(res, '文件不存在', 404);
        return json(res, { ok: true, message: `文件已重命名为 ${body.new_name}` });
      }
    }

    // --- Asset Upload ---
    if (pathname === '/api/assets/upload' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.filename || !body.content) return err(res, '缺少 filename 或 content 字段', 400);
      const folder = body.folder || '';
      const targetDir = folder ? path.join(BASE_DIR, 'assets', folder) : path.join(BASE_DIR, 'assets');
      // 安全检查
      if (!targetDir.startsWith(path.join(BASE_DIR, 'assets'))) return err(res, '无效路径', 403);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const buffer = Buffer.from(body.content, 'base64');
      fs.writeFileSync(path.join(targetDir, body.filename), buffer);
      return json(res, { ok: true, message: `文件 ${body.filename} 上传成功`, path: path.join(folder, body.filename) });
    }

    // --- Canvas Data Persistence ---
    const canvasMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasMatch) {
      const id = canvasMatch[1];
      const canvasesDir = path.join(DATA_DIR, 'canvases');
      if (!fs.existsSync(canvasesDir)) fs.mkdirSync(canvasesDir, { recursive: true });
      const canvasFile = path.join(canvasesDir, `${id}.json`);
      if (req.method === 'GET') {
        if (!fs.existsSync(canvasFile)) return json(res, { canvas: { id, nodes: [], connections: [], viewport: { x: 0, y: 0, zoom: 1 } } });
        try {
          const data = JSON.parse(fs.readFileSync(canvasFile, 'utf-8'));
          return json(res, { canvas: data });
        } catch(e) { return err(res, '画布数据损坏', 500); }
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        const canvasData = { id, ...body, updated_at: new Date().toISOString() };
        fs.writeFileSync(canvasFile, JSON.stringify(canvasData, null, 2), 'utf-8');
        return json(res, { canvas: canvasData });
      }
    }

    // --- Canvas Management ---
    if (pathname === '/api/canvases') {
      const canvasesDir = path.join(DATA_DIR, 'canvases');
      if (!fs.existsSync(canvasesDir)) fs.mkdirSync(canvasesDir, { recursive: true });
      if (req.method === 'GET') {
        const files = fs.readdirSync(canvasesDir).filter(f => f.endsWith('.json'));
        const list = files.map(f => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(canvasesDir, f), 'utf-8'));
            return { id: data.id, name: data.title || data.name || f.replace('.json', ''), updated_at: data.updated_at };
          } catch(e) { return { id: f.replace('.json', ''), name: f.replace('.json', ''), updated_at: null }; }
        });
        return json(res, { canvases: list });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const id = genId();
        const canvasData = { id, name: body.title || body.name || '新画布', nodes: body.nodes || [], connections: body.connections || [], viewport: body.viewport || { x: 0, y: 0, zoom: 1 }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        const canvasFile = path.join(canvasesDir, `${id}.json`);
        fs.writeFileSync(canvasFile, JSON.stringify(canvasData, null, 2), 'utf-8');
        return json(res, { canvas: canvasData });
      }
    }
    const canvasesDeleteMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasesDeleteMatch && req.method === 'DELETE') {
      const id = canvasesDeleteMatch[1];
      const canvasFile = path.join(DATA_DIR, 'canvases', `${id}.json`);
      if (fs.existsSync(canvasFile)) fs.unlinkSync(canvasFile);
      return json(res, { ok: true, message: `画布 ${id} 已删除` });
    }
    const canvasMetaMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/meta$/);
    if (canvasMetaMatch && (req.method === 'GET' || req.method === 'POST')) {
      const id = canvasMetaMatch[1];
      const canvasFile = path.join(DATA_DIR, 'canvases', `${id}.json`);
      if (req.method === 'GET') {
        if (!fs.existsSync(canvasFile)) return json(res, { updated_at: 0 });
        try {
          const data = JSON.parse(fs.readFileSync(canvasFile, 'utf-8'));
          return json(res, { id: data.id, name: data.name || data.title, updated_at: data.updated_at, pinned: data.pinned, icon: data.icon });
        } catch(e) { return json(res, { updated_at: 0 }); }
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        let data = { id, nodes: [], connections: [], viewport: { x:0, y:0, zoom:1 } };
        if (fs.existsSync(canvasFile)) {
          try { data = JSON.parse(fs.readFileSync(canvasFile, 'utf-8')); } catch(e) {}
        }
        Object.assign(data, body, { updated_at: new Date().toISOString() });
        fs.writeFileSync(canvasFile, JSON.stringify(data, null, 2), 'utf-8');
        return json(res, { ok: true, canvas: data });
      }
    }

    // --- Chat (SSE) ---
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const config = loadConfig();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });

      // 心跳保活：每30秒发送注释行，防止连接被代理/防火墙断开
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': heartbeat\n\n');
      }, 30000);

      function finishSSE(text) {
        clearInterval(heartbeat);
        if (res.writableEnded) return;
        const toolCalls = extractToolCalls(text);
        if (toolCalls.length > 0) {
          res.write(`data: ${JSON.stringify({ type: 'tool_calls', calls: toolCalls })}\n\n`);
          executeToolCalls(toolCalls, config).then(results => {
            res.write(`data: ${JSON.stringify({ type: 'tool_results', results })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end();
          }).catch(e => {
            res.write(`data: ${JSON.stringify({ type: 'tool_error', error: e.message })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end();
          });
        } else {
          res.write('data: [DONE]\n\n'); res.end();
        }
      }

      try {
        const llmRes = await agentChat(body.message, body.conversation_id, body.history || [], body.files || [], config, body.skills || null);
        let fullText = '', buffer = '';

        llmRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                finishSSE(fullText);
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                if (delta && delta.content) {
                  fullText += delta.content;
                  res.write(`data: ${JSON.stringify({ type: 'content', text: delta.content })}\n\n`);
                }
                // 处理 finish_reason（模型因 max_tokens 停止）
                if (parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason) {
                  const reason = parsed.choices[0].finish_reason;
                  if (reason === 'length') {
                    fullText += '\n\n[内容较长，已截断显示]';
                    res.write(`data: ${JSON.stringify({ type: 'content', text: '\n\n[内容较长，已截断显示]' })}\n\n`);
                  }
                }
              } catch(e) {}
            }
          }
        });
        llmRes.on('end', () => {
          // 刷新剩余缓冲区
          if (buffer.trim()) {
            const leftover = buffer.trim();
            if (leftover.startsWith('data: ')) {
              const data = leftover.slice(6).trim();
              if (data !== '[DONE]') {
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                  if (delta && delta.content) {
                    fullText += delta.content;
                    res.write(`data: ${JSON.stringify({ type: 'content', text: delta.content })}\n\n`);
                  }
                } catch(e) {}
              }
            }
          }
          finishSSE(fullText);
        });
        llmRes.on('error', (e) => {
          clearInterval(heartbeat);
          if (!res.writableEnded) {
            // 即使出错也把已收集的内容发完
            if (fullText) res.write(`data: ${JSON.stringify({ type: 'content', text: '' })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
            res.write('data: [DONE]\n\n'); res.end();
          }
        });
      } catch(e) {
        clearInterval(heartbeat);
        res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
        res.write('data: [DONE]\n\n'); res.end();
      }
      return;
    }

    // --- Generate Image ---
    if (pathname === '/api/generate-image' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const config = loadConfig();
      const genModel = body.model || config.model || 'gpt-image-1';
      const genSize = body.size || '1024x1024';
      const prompt = (body.prompt || '').trim();
      if (!prompt) return err(res, '请输入图片描述', 400);

      // API config: request body > config.json > default
      let apiBaseUrl = (body.api_base_url || config.llm_base_url || 'https://tinysnow.one').replace(/\/+$/, '');
      let apiKey = body.api_key || config.api_key || '';
      let apiUrl;
      if (apiBaseUrl.endsWith('/v1/images/generations')) {
        apiUrl = new URL(apiBaseUrl);
      } else if (apiBaseUrl.endsWith('/v1')) {
        apiUrl = new URL(apiBaseUrl + '/images/generations');
      } else {
        apiUrl = new URL(apiBaseUrl + '/v1/images/generations');
      }

      let imgBody;
      if (body.ref_images && body.ref_images.length > 0) {
        // Has reference image - use edits endpoint
        const editPath = apiUrl.pathname.replace('/images/generations', '/images/edits');
        apiUrl.pathname = editPath;
        imgBody = JSON.stringify({
          model: genModel,
          prompt: prompt,
          n: 1,
          size: genSize,
          response_format: 'b64_json',
          image: body.ref_images[0]
        });
      } else {
        imgBody = JSON.stringify({
          model: genModel,
          prompt: prompt,
          n: 1,
          size: genSize,
          response_format: 'b64_json'
        });
      }
      const imgOpts = {
        hostname: apiUrl.hostname, port: apiUrl.port || 443, path: apiUrl.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(imgBody) },
        timeout: 180000
      };
      const imgReq = https.request(imgOpts, (imgRes) => {
        let imgData = '';
        imgRes.on('data', c => imgData += c);
        imgRes.on('end', () => {
          if (imgRes.statusCode !== 200) {
            try {
              const errJson = JSON.parse(imgData);
              return err(res, '图片生成失败: ' + (errJson.error?.message || imgData.slice(0, 200)), imgRes.statusCode);
            } catch(e) {
              return err(res, '图片生成失败: ' + imgData.slice(0, 200), imgRes.statusCode);
            }
          }
          try {
            const result = JSON.parse(imgData);
            const b64 = result.data && result.data[0] && result.data[0].b64_json;
            if (b64) {
              const safeName = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.png';
              const savePath = path.join(DATA_DIR, 'uploads', safeName);
              fs.writeFileSync(savePath, Buffer.from(b64, 'base64'));
              return json(res, { url: '/uploads/' + safeName, revised_prompt: result.data[0].revised_prompt || prompt });
            }
            const url = result.data && result.data[0] && result.data[0].url;
            if (url) return json(res, { url: url, revised_prompt: result.data[0].revised_prompt || prompt });
            return err(res, '未收到图片数据', 500);
          } catch(e) {
            return err(res, '解析图片数据失败: ' + e.message, 500);
          }
        });
      });
      imgReq.on('timeout', () => { imgReq.destroy(); });
      imgReq.on('error', (e) => err(res, '图片生成请求失败: ' + e.message, 500));
      imgReq.write(imgBody);
      imgReq.end();
      return;
    }

    // --- Upload files (base64) ---
    if (pathname === '/api/upload' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.files || !Array.isArray(body.files)) return err(res, '缺少 files 数组', 400);
      const results = [];
      for (const f of body.files) {
        if (!f.name || !f.data) continue;
        const ext = path.extname(f.name).toLowerCase() || '.bin';
        const safeName = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
        const savePath = path.join(DATA_DIR, 'uploads', safeName);
        try {
          const buffer = Buffer.from(f.data, 'base64');
          fs.writeFileSync(savePath, buffer);
          results.push({
            name: f.name,
            savedName: safeName,
            url: '/uploads/' + safeName,
            type: f.type || 'application/octet-stream',
            size: buffer.length
          });
        } catch(e) { results.push({ name: f.name, error: e.message }); }
      }
      return json(res, { files: results });
    }

    // --- Serve uploaded files ---
    if (pathname.startsWith('/uploads/')) {
      const fileName = pathname.replace('/uploads/', '');
      const filePath = path.join(DATA_DIR, 'uploads', fileName);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown' };
        const ct = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      return err(res, 'File not found', 404);
    }

    // --- Generate image ---
    if (pathname === '/api/generate-image' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const config = loadConfig();
      try { return json(res, await generateImage(body.prompt, body.size || '1024x1024', config)); }
      catch(e) { return err(res, e.message); }
    }

    // ==================== AI Studio Compatible APIs ====================

    // --- Providers API (API设置) ---
    if (pathname === '/api/providers') {
      const providersFile = path.join(DATA_DIR, 'providers.json');
      if (req.method === 'GET') {
        if (fs.existsSync(providersFile)) {
          try {
            const raw = JSON.parse(fs.readFileSync(providersFile, 'utf-8'));
            return json(res, Array.isArray(raw) ? { providers: raw } : raw);
          } catch(e) {}
        }
        return json(res, { providers: [] });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        fs.writeFileSync(providersFile, JSON.stringify(body, null, 2), 'utf-8');
        return json(res, { ok: true, message: 'Providers saved' });
      }
    }
    if (pathname === '/api/providers/test-connection' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const baseUrl = (body.base_url || '').trim();
      const apiKey = (body.api_key || '').trim();
      if (!baseUrl) return json(res, { ok: false, connected: false, message: '请填写 Base URL' });
      try {
        let testUrl = baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '') + '/models';
        const urlObj = new URL(testUrl);
        const httpMod = urlObj.protocol === 'https:' ? require('https') : require('http');
        const result = await new Promise((resolve, reject) => {
          const req2 = httpMod.request({
            hostname: urlObj.hostname, port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''), method: 'GET',
            headers: { 'Authorization': 'Bearer ' + apiKey }, timeout: 10000
          }, (upRes) => { let d = ''; upRes.on('data', c => d += c); upRes.on('end', () => resolve({ status: upRes.statusCode })); });
          req2.on('error', reject);
          req2.on('timeout', () => { req2.destroy(); reject(new Error('超时')); });
          req2.end();
        });
        const ok = result.status >= 200 && result.status < 300;
        return json(res, { ok, connected: ok, message: ok ? '连接成功' : '连接失败 (HTTP ' + result.status + ')' });
      } catch(e) {
        return json(res, { ok: false, connected: false, message: '连接失败: ' + e.message });
      }
    }
    if (pathname === '/api/providers/fetch-models' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const baseUrl = (body.base_url || '').trim();
      const apiKey = (body.api_key || '').trim();
      const protocol = body.protocol || 'openai';
      if (!baseUrl) return json(res, { ok: false, detail: 'Base URL 不能为空' });

      try {
        let modelsUrl = baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '') + '/models';
        const urlObj = new URL(modelsUrl);
        const httpMod = urlObj.protocol === 'https:' ? require('https') : require('http');
        const result = await new Promise((resolve, reject) => {
          const req2 = httpMod.request({
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + (urlObj.search || ''),
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            timeout: 20000
          }, (upRes) => {
            let data = '';
            upRes.on('data', c => data += c);
            upRes.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('响应解析失败')); } });
          });
          req2.on('error', reject);
          req2.on('timeout', () => { req2.destroy(); reject(new Error('请求超时(20s)')); });
          req2.end();
        });
        const all = (result.data || result.models || []).map(m => typeof m === 'string' ? m : (m.id || m.name || String(m)));
        const imageModels = all.filter(m => /dall|flux|stable|image|sdxl|midjourney|cogview|wanx|kolors|playground/i.test(m));
        const videoModels = all.filter(m => /video|sora|runway|kling|pika|seedance|luma|cogvideo/i.test(m));
        const chatModels = all.filter(m => !imageModels.includes(m) && !videoModels.includes(m));
        return json(res, { ok: true, all, total: all.length, image_models: imageModels, chat_models: chatModels, video_models: videoModels, protocol });
      } catch(e) {
        return json(res, { ok: false, detail: '拉取失败: ' + e.message });
      }
    }

    // --- Workflows API (ComfyUI工作流) ---
    if (pathname === '/api/workflows') {
      const workflowsFile = path.join(DATA_DIR, 'workflows.json');
      if (req.method === 'GET') {
        if (fs.existsSync(workflowsFile)) {
          try { return json(res, JSON.parse(fs.readFileSync(workflowsFile, 'utf-8'))); } catch(e) {}
        }
        return json(res, { workflows: [] });
      }
    }

    // --- RunningHub API ---
    if (pathname === '/api/runninghub/workflows') {
      const rhFile = path.join(DATA_DIR, 'runninghub-workflows.json');
      if (req.method === 'GET') {
        if (fs.existsSync(rhFile)) {
          try { return json(res, JSON.parse(fs.readFileSync(rhFile, 'utf-8'))); } catch(e) {}
        }
        return json(res, { workflows: [] });
      }
    }
    if (pathname === '/api/runninghub/workflows/fetch' && req.method === 'POST') {
      return json(res, { ok: true, workflows: [], message: 'RunningHub fetch requires backend service' });
    }

    // --- Asset Library API (资产库) ---
    if (pathname === '/api/asset-library') {
      const assetLibFile = path.join(DATA_DIR, 'asset-library.json');
      if (req.method === 'GET') {
        if (fs.existsSync(assetLibFile)) {
          try { return json(res, JSON.parse(fs.readFileSync(assetLibFile, 'utf-8'))); } catch(e) {}
        }
        return json(res, { items: [], categories: [] });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        fs.writeFileSync(assetLibFile, JSON.stringify(body, null, 2), 'utf-8');
        return json(res, { ok: true, message: 'Asset library saved' });
      }
    }
    if (pathname === '/api/asset-library/items' && req.method === 'POST') {
      const assetLibFile = path.join(DATA_DIR, 'asset-library.json');
      let data = { items: [], categories: [] };
      if (fs.existsSync(assetLibFile)) {
        try { data = JSON.parse(fs.readFileSync(assetLibFile, 'utf-8')); } catch(e) {}
      }
      const body = JSON.parse(await readBody(req));
      const item = { id: genId(), ...body, created_at: new Date().toISOString() };
      data.items = data.items || [];
      data.items.push(item);
      fs.writeFileSync(assetLibFile, JSON.stringify(data, null, 2), 'utf-8');
      return json(res, { ok: true, item });
    }
    const assetLibDeleteMatch = pathname.match(/^\/api\/asset-library\/items\/([^/]+)$/);
    if (assetLibDeleteMatch && req.method === 'DELETE') {
      const itemId = assetLibDeleteMatch[1];
      const assetLibFile = path.join(DATA_DIR, 'asset-library.json');
      if (fs.existsSync(assetLibFile)) {
        const data = JSON.parse(fs.readFileSync(assetLibFile, 'utf-8'));
        data.items = (data.items || []).filter(i => i.id !== itemId);
        fs.writeFileSync(assetLibFile, JSON.stringify(data, null, 2), 'utf-8');
      }
      return json(res, { ok: true, message: `Item ${itemId} deleted` });
    }
    if (pathname === '/api/asset-library/items/batch' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json(res, { ok: true, message: 'Batch operation completed', results: body.items || [] });
    }
    if (pathname === '/api/asset-library/categories') {
      const assetLibFile = path.join(DATA_DIR, 'asset-library.json');
      if (req.method === 'GET') {
        if (fs.existsSync(assetLibFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(assetLibFile, 'utf-8'));
            return json(res, data.categories || []);
          } catch(e) {}
        }
        return json(res, []);
      }
      if (req.method === 'POST') {
        let data = { items: [], categories: [] };
        if (fs.existsSync(assetLibFile)) {
          try { data = JSON.parse(fs.readFileSync(assetLibFile, 'utf-8')); } catch(e) {}
        }
        const body = JSON.parse(await readBody(req));
        data.categories = body;
        fs.writeFileSync(assetLibFile, JSON.stringify(data, null, 2), 'utf-8');
        return json(res, { ok: true, message: 'Categories saved' });
      }
    }

    // --- Prompt Library API (提示词库) ---
    if (pathname === '/api/prompt-libraries') {
      const promptLibFile = path.join(DATA_DIR, 'prompt-libraries.json');
      if (req.method === 'GET') {
        if (fs.existsSync(promptLibFile)) {
          try { return json(res, JSON.parse(fs.readFileSync(promptLibFile, 'utf-8'))); } catch(e) {}
        }
        return json(res, { items: [], categories: [] });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        fs.writeFileSync(promptLibFile, JSON.stringify(body, null, 2), 'utf-8');
        return json(res, { ok: true, message: 'Prompt library saved' });
      }
    }
    if (pathname === '/api/prompt-libraries/items' && req.method === 'POST') {
      const promptLibFile = path.join(DATA_DIR, 'prompt-libraries.json');
      let data = { items: [], categories: [] };
      if (fs.existsSync(promptLibFile)) {
        try { data = JSON.parse(fs.readFileSync(promptLibFile, 'utf-8')); } catch(e) {}
      }
      const body = JSON.parse(await readBody(req));
      const item = { id: genId(), ...body, created_at: new Date().toISOString() };
      data.items = data.items || [];
      data.items.push(item);
      fs.writeFileSync(promptLibFile, JSON.stringify(data, null, 2), 'utf-8');
      return json(res, { ok: true, item });
    }
    const promptLibDeleteMatch = pathname.match(/^\/api\/prompt-libraries\/items\/([^/]+)$/);
    if (promptLibDeleteMatch && req.method === 'DELETE') {
      const itemId = promptLibDeleteMatch[1];
      const promptLibFile = path.join(DATA_DIR, 'prompt-libraries.json');
      if (fs.existsSync(promptLibFile)) {
        const data = JSON.parse(fs.readFileSync(promptLibFile, 'utf-8'));
        data.items = (data.items || []).filter(i => i.id !== itemId);
        fs.writeFileSync(promptLibFile, JSON.stringify(data, null, 2), 'utf-8');
      }
      return json(res, { ok: true, message: `Item ${itemId} deleted` });
    }
    if (pathname === '/api/prompt-libraries/categories') {
      const promptLibFile = path.join(DATA_DIR, 'prompt-libraries.json');
      if (req.method === 'GET') {
        if (fs.existsSync(promptLibFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(promptLibFile, 'utf-8'));
            return json(res, data.categories || []);
          } catch(e) {}
        }
        return json(res, []);
      }
      if (req.method === 'POST') {
        let data = { items: [], categories: [] };
        if (fs.existsSync(promptLibFile)) {
          try { data = JSON.parse(fs.readFileSync(promptLibFile, 'utf-8')); } catch(e) {}
        }
        const body = JSON.parse(await readBody(req));
        data.categories = body;
        fs.writeFileSync(promptLibFile, JSON.stringify(data, null, 2), 'utf-8');
        return json(res, { ok: true, message: 'Categories saved' });
      }
    }

    // --- Local Assets API (本地素材) ---
    if (pathname === '/api/local-assets' && req.method === 'GET') {
      const localAssetsFile = path.join(DATA_DIR, 'local-assets.json');
      if (fs.existsSync(localAssetsFile)) {
        try { return json(res, JSON.parse(fs.readFileSync(localAssetsFile, 'utf-8'))); } catch(e) {}
      }
      return json(res, { items: [] });
    }
    if (pathname === '/api/local-assets/upload' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json(res, { ok: true, message: 'Local asset upload requires backend service', item: body });
    }
    if (pathname === '/api/local-assets/import-urls' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json(res, { ok: true, message: 'URL import requires backend service', items: [] });
    }
    if (pathname === '/api/local-assets/delete' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json(res, { ok: true, message: 'Local asset deleted' });
    }
    if (pathname === '/api/local-assets/items' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json(res, { ok: true, message: 'Local asset item updated', item: body });
    }

    // --- Canvas Extensions API ---
    if (pathname === '/api/canvases/trash' && req.method === 'GET') {
      const trashDir = path.join(DATA_DIR, 'canvases-trash');
      if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
      const files = fs.readdirSync(trashDir).filter(f => f.endsWith('.json'));
      const list = files.map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(trashDir, f), 'utf-8'));
          return { id: data.id, name: data.name || f.replace('.json', ''), deleted_at: data.deleted_at };
        } catch(e) { return { id: f.replace('.json', ''), name: f.replace('.json', ''), deleted_at: null }; }
      });
      return json(res, list);
    }
    const canvasRestoreMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/restore$/);
    if (canvasRestoreMatch && req.method === 'POST') {
      const id = canvasRestoreMatch[1];
      const trashFile = path.join(DATA_DIR, 'canvases-trash', `${id}.json`);
      const canvasFile = path.join(DATA_DIR, 'canvases', `${id}.json`);
      if (fs.existsSync(trashFile)) {
        fs.copyFileSync(trashFile, canvasFile);
        fs.unlinkSync(trashFile);
        return json(res, { ok: true, message: `Canvas ${id} restored` });
      }
      return err(res, 'Canvas not found in trash', 404);
    }
    const canvasPurgeMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/purge$/);
    if (canvasPurgeMatch && req.method === 'DELETE') {
      const id = canvasPurgeMatch[1];
      const trashFile = path.join(DATA_DIR, 'canvases-trash', `${id}.json`);
      if (fs.existsSync(trashFile)) fs.unlinkSync(trashFile);
      return json(res, { ok: true, message: `Canvas ${id} purged` });
    }
    const canvasTouchMatch = pathname.match(/^\/api\/canvases\/([^/]+)\/touch$/);
    if (canvasTouchMatch && req.method === 'POST') {
      const id = canvasTouchMatch[1];
      const canvasFile = path.join(DATA_DIR, 'canvases', `${id}.json`);
      if (fs.existsSync(canvasFile)) {
        const data = JSON.parse(fs.readFileSync(canvasFile, 'utf-8'));
        data.updated_at = new Date().toISOString();
        fs.writeFileSync(canvasFile, JSON.stringify(data, null, 2), 'utf-8');
      }
      return json(res, { ok: true, message: `Canvas ${id} touch updated` });
    }
    const canvasPatchMatch = pathname.match(/^\/api\/canvases\/([^/]+)$/);
    if (canvasPatchMatch && req.method === 'PATCH') {
      const id = canvasPatchMatch[1];
      const canvasFile = path.join(DATA_DIR, 'canvases', `${id}.json`);
      let data = { id, nodes: [], connections: [], viewport: { x: 0, y: 0, zoom: 1 } };
      if (fs.existsSync(canvasFile)) {
        try { data = JSON.parse(fs.readFileSync(canvasFile, 'utf-8')); } catch(e) {}
      }
      const body = JSON.parse(await readBody(req));
      Object.assign(data, body, { updated_at: new Date().toISOString() });
      fs.writeFileSync(canvasFile, JSON.stringify(data, null, 2), 'utf-8');
      return json(res, { ok: true, id });
    }

    // --- AI Generation API (桩实现) ---
    if (pathname === '/api/ai/upload' && req.method === 'POST') {
      return json(res, { ok: true, message: 'AI upload requires backend service', url: '' });
    }
    if (pathname === '/api/ai/import-local-image' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Import local image requires backend service', url: '' });
    }
    // --- Canvas Image Generation (代理到配置的图片API提供商) ---
    if (pathname === '/api/online-image' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const config = loadConfig();
      const providers = config.api_providers || [];
      const providerId = body.provider_id || providers[0]?.id || 'comfly';
      const provider = providers.find(p => p.id === providerId) || providers[0];
      if (!provider) return json(res, { ok: true, images: [] });
      const baseUrl = (provider.image_api_url || provider.base_url || '').trim();
      const apiKey = (provider.api_key || provider.key || '').trim();
      if (!baseUrl) return json(res, { ok: true, images: [] });
      try {
        const imgPayload = { prompt: body.prompt || '', model: body.model || config.image_model || 'gpt-image-2', size: body.size || '1024x1024', n: body.n || 1, quality: body.quality || 'high' };
        if (body.images && body.images.length) imgPayload.images = body.images;
        const url = new URL(baseUrl);
        const proto = url.protocol === 'https:' ? https : http;
        const postData = JSON.stringify(imgPayload);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        if (provider.headers && typeof provider.headers === 'object') Object.assign(headers, provider.headers);
        const result = await new Promise((resolve, reject) => {
          const proxyReq = proto.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers, timeout: 120000 }, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ images: [] }); } });
          });
          proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('图片API请求超时')); });
          proxyReq.on('error', reject);
          proxyReq.write(postData);
          proxyReq.end();
        });
        if (result.Response && result.Response.Error) return json(res, { ok: false, error: result.Response.Error.Message, images: [] });
        const images = result.images || result.data || result.output || [];
        return json(res, { ok: true, images: Array.isArray(images) ? images : [] });
      } catch(e) { return json(res, { ok: true, images: [] }); }
    }
    // --- Canvas ComfyUI/通用生成 ---
    if (pathname === '/api/generate' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      // 如果有comfyui配置，转发到comfyui
      const config = loadConfig();
      const comfyInstances = config.comfy_instances || [];
      if (comfyInstances.length && body.type === 'workflow') {
        const comfy = comfyInstances[0];
        try {
          const url = new URL(comfy.url || 'http://127.0.0.1:8188');
          const proto = url.protocol === 'https:' ? https : http;
          const postData = JSON.stringify(body);
          const result = await new Promise((resolve, reject) => {
            const proxyReq = proto.request({ hostname: url.hostname, port: url.port || 8188, path: '/prompt', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }, timeout: 120000 }, (proxyRes) => {
              let data = '';
              proxyRes.on('data', chunk => data += chunk);
              proxyRes.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: 'ComfyUI响应解析失败' }); } });
            });
            proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('ComfyUI请求超时')); });
            proxyReq.on('error', reject);
            proxyReq.write(postData);
            proxyReq.end();
          });
          return json(res, result);
        } catch(e) { return json(res, { error: e.message }); }
      }
      return json(res, { ok: true, message: 'Generation requires backend configuration', result: null });
    }
    // --- Canvas LLM ---
    if (pathname === '/api/canvas-llm' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const config = loadConfig();
      try {
        const messages = [{ role: 'user', content: body.prompt || body.message || '' }];
        const llmRes = await callLLM(messages, config, false);
        let data = '';
        await new Promise((resolve, reject) => {
          llmRes.on('data', chunk => data += chunk);
          llmRes.on('end', resolve);
          llmRes.on('error', reject);
        });
        const parsed = JSON.parse(data);
        const text = parsed.choices?.[0]?.message?.content || '';
        return json(res, { ok: true, text });
      } catch(e) { return json(res, { ok: true, text: '' }); }
    }
    if (pathname === '/api/canvas-assets/check' && req.method === 'POST') {
      return json(res, { ok: true, exists: {} });
    }
    if (pathname === '/api/canvas-assets/download' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Download requires backend service' });
    }
    if (pathname === '/api/cloud-video/upload' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Cloud video upload requires backend', url: '' });
    }
    if (pathname === '/api/canvas-image-tasks' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Image tasks require backend service', tasks: [] });
    }
    // --- Canvas Video Generation (代理到配置的视频API提供商) ---
    if (pathname === '/api/canvas-video' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const config = loadConfig();
      const providers = config.api_providers || [];
      const providerId = body.provider_id || 'comfly';
      const provider = providers.find(p => p.id === providerId) || providers[0];
      if (!provider) return json(res, { ok: false, error: '未找到视频API提供商配置' });
      const baseUrl = (provider.base_url || '').trim();
      const apiKey = (provider.api_key || provider.key || '').trim();
      if (!baseUrl) return json(res, { ok: false, error: '视频API提供商未配置 base_url' });
      try {
        const videoPayload = {
          prompt: body.prompt || '',
          model: body.model || 'veo3-fast',
          duration: body.duration || 5,
          aspect_ratio: body.aspect_ratio || '16:9',
          resolution: body.resolution || '',
          images: body.images || [],
          videos: body.videos || [],
          enhance_prompt: body.enhance_prompt || false,
          enable_upsample: body.enable_upsample || false,
          watermark: body.watermark || false,
          camerafixed: body.camerafixed || false,
          generate_audio: body.generate_audio || false,
          multimodal: body.multimodal || false
        };
        const url = new URL(baseUrl);
        const proto = url.protocol === 'https:' ? https : http;
        const postData = JSON.stringify(videoPayload);
        // 构建请求头（支持腾讯云API标准头）
        const headers = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        // 如果是腾讯云风格的API（host包含tencent或base_url路径包含tencent），添加X-TC头
        const isTencentStyle = (url.hostname.includes('tencent') || url.hostname.includes('.tencent') ||
          baseUrl.includes('tencent') || baseUrl.includes('aistudio') || baseUrl.includes('yuyu'));
        if (isTencentStyle) {
          headers['X-TC-Action'] = 'SubmitVideoGenerationJob';
          headers['X-TC-Version'] = '2024-07-01';
          headers['X-TC-Timestamp'] = String(Math.floor(Date.now() / 1000));
          headers['X-TC-Region'] = 'ap-guangzhou';
        }
        // 如果provider配置了额外的headers
        if (provider.headers && typeof provider.headers === 'object') {
          Object.assign(headers, provider.headers);
        }
        const result = await new Promise((resolve, reject) => {
          const reqOpts = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers,
            timeout: 180000
          };
          const proxyReq = proto.request(reqOpts, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
              try { resolve({ status: proxyRes.statusCode, data: JSON.parse(data) }); }
              catch(e) { resolve({ status: proxyRes.statusCode, data: { raw: data.slice(0, 2000) } }); }
            });
          });
          proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('视频API请求超时')); });
          proxyReq.on('error', reject);
          proxyReq.write(postData);
          proxyReq.end();
        });
        // 转发上游响应给前端
        if (result.data && result.data.Response && result.data.Response.Error) {
          return json(res, { ok: false, error: result.data.Response.Error.Message || '视频生成API调用失败', upstream: result.data });
        }
        return json(res, result.data || { ok: true, video: null });
      } catch(e) {
        return json(res, { ok: false, error: '视频生成请求失败: ' + e.message });
      }
    }
    if (pathname === '/api/image-task-query' && req.method === 'GET') {
      return json(res, { ok: true, message: 'Task query requires backend service', status: 'pending', progress: 0 });
    }
    if (pathname === '/api/canvas-workflows/export' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Workflow export requires backend service', workflow: null });
    }
    if (pathname === '/api/canvas-workflows/import' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Workflow import requires backend service', workflow: null });
    }
    if (pathname === '/api/smart-canvas/prompt-templates' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Prompt templates require backend service', templates: [] });
    }
    if (pathname === '/api/media-preview' && req.method === 'GET') {
      const mediaUrl = url.searchParams.get('url');
      if (!mediaUrl) return err(res, 'Missing url parameter', 400);
      return json(res, { ok: true, message: 'Media preview proxy requires backend service', url: mediaUrl });
    }

    // --- Jimeng CLI API (桩实现) ---
    if (pathname === '/api/jimeng/status' && req.method === 'GET') {
      return json(res, { ok: true, status: 'disconnected', message: 'Jimeng CLI not available' });
    }
    if (pathname === '/api/jimeng/login/start' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Jimeng login requires CLI service', loginUrl: '' });
    }
    if (pathname === '/api/jimeng/credit' && req.method === 'GET') {
      return json(res, { ok: true, credit: 0, message: 'Jimeng credit query requires CLI service' });
    }
    if (pathname === '/api/jimeng/logout' && req.method === 'POST') {
      return json(res, { ok: true, message: 'Jimeng logout requires CLI service' });
    }
    if (pathname === '/api/jimeng/help' && req.method === 'GET') {
      return json(res, { ok: true, help: 'Jimeng CLI help requires CLI service', commands: [] });
    }

    // --- Static file serving ---
    if (pathname.startsWith('/assets/') || pathname.startsWith('/skills/')) {
      let filePath;
      if (pathname.startsWith('/assets/')) {
        const relPath = pathname.slice('/assets/'.length);
        const baseAssetsPath = path.join(BASE_DIR, 'assets', relPath);
        const localAssetsPath = path.join(__dirname, 'assets', relPath);
        filePath = fs.existsSync(baseAssetsPath) ? baseAssetsPath : localAssetsPath;
      } else {
        filePath = path.join(__dirname, pathname);
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } else { err(res, 'Not found', 404); }
      return;
    }

    // --- Update Check (GitHub Releases) ---
    if (pathname === '/api/update/check') {
      try {
        const pkg = require('./package.json');
        const currentVersion = pkg.version || '3.1.2';
        // GitHub Releases API — 修改这里的 owner/repo 为你的仓库
        const owner = process.env.SF_GITHUB_OWNER || 'HamlitonAlex';
        const repo = process.env.SF_GITHUB_REPO || 'StoryForge-AI';
        const ghApiUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/latest';

        const doCheck = () => new Promise((resolve) => {
          const https = require('https');
          const options = {
            hostname: 'api.github.com',
            path: '/repos/' + owner + '/' + repo + '/releases/latest',
            method: 'GET',
            timeout: 6000,
            headers: { 'User-Agent': 'StoryForge-AI-UpdateChecker', 'Accept': 'application/vnd.github.v3+json' }
          };
          const req = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
              try {
                if (response.statusCode !== 200) {
                  resolve({ currentVersion, latestVersion: currentVersion, updateAvailable: false, downloadUrl: '', releaseNotes: '', error: 'GitHub API 返回 ' + response.statusCode });
                  return;
                }
                const release = JSON.parse(data);
                const latest = release.tag_name ? release.tag_name.replace(/^v/, '') : '0.0.0';
                const updateAvailable = compareVersions(latest, currentVersion) > 0;
                // 找到 .exe 安装包的下载链接
                let downloadUrl = release.html_url || '';
                if (release.assets && release.assets.length > 0) {
                  const exeAsset = release.assets.find(a => a.name.endsWith('.exe') && a.name.includes('Setup'));
                  if (exeAsset) downloadUrl = exeAsset.browser_download_url;
                }
                resolve({
                  currentVersion,
                  latestVersion: latest,
                  updateAvailable,
                  downloadUrl,
                  releaseNotes: release.body ? release.body.substring(0, 500) : ''
                });
              } catch(e) {
                resolve({ currentVersion, latestVersion: currentVersion, updateAvailable: false, downloadUrl: '', releaseNotes: '' });
              }
            });
          });
          req.on('error', () => {
            resolve({ currentVersion, latestVersion: currentVersion, updateAvailable: false, downloadUrl: '', releaseNotes: '', error: '网络不可用' });
          });
          req.on('timeout', () => { req.destroy(); resolve({ currentVersion, latestVersion: currentVersion, updateAvailable: false, downloadUrl: '', releaseNotes: '', error: '请求超时' }); });
          req.end();
        });

        const result = await doCheck();
        return json(res, result);
      } catch(e) {
        return json(res, { currentVersion: '3.1.2', latestVersion: '3.1.2', updateAvailable: false, downloadUrl: '', releaseNotes: '' });
      }
    }

    err(res, 'Not found', 404);
  } catch(e) {
    console.error('Server error:', e);
    err(res, e.message);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 被占用，1秒后重试...`);
    setTimeout(() => { server.close(); server.listen(PORT); }, 1000);
  }
});

server.listen(PORT, () => {
  console.log(`StoryForge AI - Agent服务运行在 http://localhost:${PORT}`);
});
