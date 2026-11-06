# 哔哩轻小说 (linovelib) 分卷 EPUB 下载器

一个 Tampermonkey（油猴）用户脚本：在哔哩轻小说 / linovelib 的**分卷详情页**注入一个「EPUB下载」按钮，把当前分卷抓取并打包成 EPUB 2.0 电子书。

- 版本：**v1.5.0**
- 脚本文件：[`bilinovel-epub.user.js`](./bilinovel-epub.user.js)
- 依赖：Tampermonkey（无第三方库，无 `@require`）

## 功能特性

| 能力 | 说明 |
| :--- | :--- |
| 分卷入口 | 仅在 `/novel/{id}/vol_{n}.html` 挂载按钮，书籍页/目录页不注入，避免按钮泛滥 |
| 章节顺序 | 严格按分卷页目录顺序抓取；正文全程串行取页，`cid(0)` 章双向补链 |
| 字体解密 | 识别 `readfont` PUA 混淆，内置 3500 条字符字典，可选导入自定义字典 / 轮廓 Hash 字典 |
| 插图处理 | 全局并发池 + 重试退避，图床挂起时按宽限期跳过（降级为提示文本，不阻塞整卷） |
| EPUB 2.0 | 自写 `ZipWriter`：`mimetype` 首条且 STORE，文本 deflate-raw，图片 STORE，兼容主流阅读器 |
| 正文顺序通道 | 自动探测「脚本请求 vs 真实导航」的正文顺序差异，必要时切换取文通道（v1.5.0） |
| 速度档位 | 标准 / 快速 / 极速三档，命中 429、503 自动降档 |

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展；
2. 打开脚本文件 [`bilinovel-epub.user.js`](./bilinovel-epub.user.js)，点击右上角 **Raw**；
3. Tampermonkey 会弹出安装页，点击「安装」；
4. 确认脚本在 `www.linovelib.com` / `w.linovelib.com` 上已启用。

> 直接安装地址（复制到浏览器地址栏，Tampermonkey 会自动弹出安装页）：
> `https://raw.githubusercontent.com/chenhcy2hj/bilinovel-epub/main/bilinovel-epub.user.js`

> 也可以把脚本内容整体复制到 Tampermonkey 的「添加新脚本」里保存。

## 使用

1. 打开任意**分卷详情页**，例如 `https://www.linovelib.com/novel/2771/vol_132334.html`；
2. 在「目录」标题旁点击 **EPUB下载**；
3. 按钮会依次显示 `读取本卷目录…` → `抓取中: 章节 x/y (第n页)` → `下载图片: a/b` → `正在打包 EPUB…` → `打包完成 x.xMB/y.ys`；
4. 完成后浏览器自动下载 `书名 - 卷名.epub`。

抓取过程中按钮文字即为进度，可随时打开控制台看详细日志。

## 速度档位

通过 Tampermonkey 菜单（脚本图标 → 命令）切换：

| 档位 | 正文间隔 | 插图并发 | 说明 |
| :--- | ---: | ---: | :--- |
| 标准 `safe` | 800–1500 ms | 3 | 原设计基线，最稳 |
| 快速 `fast` | 500–900 ms | 6 | **默认** |
| 极速 `turbo` | 250–500 ms | 8 | 风控风险较高 |

收到 `429 / 503` 时会自动降档并继续，不需要手动干预。正文请求始终串行，这是站点的反爬约束，不要改成并发。

## 正文顺序说明（v1.5.0）

站点的章节 HTML 对**脚本请求**（`GM_xmlhttpRequest` 等）下发的是**段落被置换过**的正文：前 20 段顺序正确，之后是一个固定置换（同一 URL 多次抓取顺序完全一致，与并发无关）。浏览器真实导航拿到的才是读者所见顺序。

脚本因此增加了「取文通道探测」：

- 每卷开始时，用 XHR 与同源隐藏 iframe（真实导航）各取同一页，比较段落指纹；
- 顺序不一致 → 整卷改走 iframe 取文；
- 顺序一致 → 继续用更快的 XHR；
- iframe 被拦截 / 超时 → 自动回退 XHR。

控制台会打印：

```text
[EPUB Downloader] 取文通道探测 { url, xhrParagraphs: 113, frameParagraphs: 113, sameOrder: false, mode: "frame" }
```

若 `sameOrder: true`，说明站点对两种请求给出的是同一份文本，此时正文顺序由站点数据决定，脚本侧无法还原。

## 字体解密（PUA）

部分章节启用 `readfont` 混淆（PUA 私有区字符）。处理策略：

1. 优先用内置 3500 条字符字典还原；
2. 若站点下发 `.ttf`，会解析 `cmap`/`glyf` 计算轮廓 Hash，配合轮廓字典还原；
3. 站点只下发 `.woff2`（Brotli + glyf 重建）时无法解析，会显式告警并回退静态字典。

可通过油猴菜单导入更完整的字典：

- **导入 PUA 字符字典 (JSON)**：`{"\ue800":"的", ...}`
- **导入轮廓 Hash 字典 (JSON)**：`{"a1b2c3d4":"的", ...}`
- **清理字体缓存**：清掉已缓存字体 URL 与动态映射

未还原的字符数会在按钮完成态与控制台 `console.warn` 中提示。

## 常见问题

**「未找到可分卷容器，未挂载下载按钮」**
只支持分卷详情页；若确认在分卷页仍报错，按 `F12` 把 `诊断信息（请把这段贴给开发者）` 整段内容反馈。

**打包阶段像卡住**
v1.4.0 起改用自写 `ZipWriter`（不再依赖 JSZip 的异步分片调度）。若仍卡住，看控制台最后一行：停在 `抓取中` 是取文阶段，停在 `等待图片完成` 是图床挂起，停在 `打包中 xx%` 才是打包。

**EPUB 里正文顺序混乱**
见上文「正文顺序说明」，看 `取文通道探测` 日志的 `sameOrder` 与 `mode`。

**个别插图显示 `[插图加载失败]`**
图床超时或防盗链，脚本已按重试 + 宽限期策略处理；缺失处会降级为提示文本，不影响整卷导出。

## 实现概要

```text
UIController   视图层：路由识别、按钮挂载与状态机、日志诊断
CatalogResolver 目录层：分卷结构与章节树解析，标记 cid(0) 缺失链接
ChapterScraper  抓取层：分页串行取文、取文通道探测、cid(0) 双向修复、插图池
FontDecryptor   解密层：readfont 检测、TTF 解析、PUA / 轮廓 Hash 映射
EpubBuilder     打包层：自写 ZipWriter、OPF/NCX/XHTML 生成、EPUB 2.0 校验
Utils           基础设施：请求封装、DOM 解析、iframe 导航取文、sleep
```

## 已知限制

- 仅导出**当前分卷**，一次一卷；同一时间全局只允许一个分卷任务在跑。
- 取文通道依赖站点 `X-Frame-Options: SAMEORIGIN`；若站点改为 `DENY` 或加 CSP `frame-ancestors`，将自动回退 XHR。
- 未做目录页整本合并导出。
- 站点结构改版可能导致挂载或解析失败，此时会输出诊断信息便于适配。

## 免责声明

本项目仅供个人学习、研究与**已购买内容的自用备份**，请勿用于批量抓取、二次分发或任何商业用途。使用产生的后果由使用者自行承担，请遵守目标站点的服务条款与当地法律法规。
