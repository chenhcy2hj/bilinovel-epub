// ==UserScript==
// @name         哔哩轻小说 (linovelib) 分卷 EPUB 下载器
// @namespace    https://www.linovelib.com/
// @version      1.6.0
// @description  在哔哩轻小说分卷详情页（/novel/{id}/vol_{n}.html）新增 EPUB 下载按钮，支持cid(0)双向修复、TTF字体轮廓解密、插图并发重试、正文乱序还原（iframe）与EPUB 2.0打包
// @author       MVP-Builder
// @updateURL    https://raw.githubusercontent.com/chenhcy2hj/bilinovel-epub/main/bilinovel-epub.user.js
// @downloadURL  https://raw.githubusercontent.com/chenhcy2hj/bilinovel-epub/main/bilinovel-epub.user.js
// @match        https://www.linovelib.com/novel/*.html
// @match        https://www.linovelib.com/novel/*/catalog*
// @match        https://w.linovelib.com/novel/*.html
// @match        https://w.linovelib.com/novel/*/catalog*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      linovelib.com
// @connect      *.linovelib.com
// @connect      bilinovel.com
// @connect      *.bilinovel.com
// @connect      *
// @run-at       document-end
// ==/UserScript==

/*
 * 仅供个人学习与已购内容的本地备份使用，禁止商业使用、再分发或公开传播。
 * Copyright © 2026 chenhcy2hj，保留所有权利（All rights reserved）。
 */

(function () {
  'use strict';

  /********************************************************************
   * 0. 全局配置与内置基准字典 (支持静态 PUA 码位 + TTF 字形轮廓 Hash)
   ********************************************************************/
  const CONFIG = {
    TEXT_DELAY_MIN: 800,       // 正文分页最小随机延迟 (ms)
    TEXT_DELAY_MAX: 1500,      // 正文分页最大随机延迟 (ms)
    IMG_CONCURRENCY: 3,        // 插图下载并发数
    IMG_MAX_RETRIES: 3,        // 单张插图最大重试次数（总尝试次数 = 1 + 该值，对齐决策 5）
    IMG_TIMEOUT: 15000,        // 插图请求超时时间 (ms)
    IMG_RETRY_BACKOFF: 600,    // 插图重试基础退避 (ms)
    IMAGE_GRACE: 12000,        // 正文抓完后等待剩余图片的上限 (ms)，超时直接跳过
    COVER_TIMEOUT: 6000,       // 封面单次请求超时 (ms)
    MOUNT_RETRY_TIMES: 10,     // 页面异步渲染时按钮挂载的轮询次数
    MOUNT_RETRY_INTERVAL: 800, // 上述轮询间隔 (ms)；另叠加 MutationObserver
    TEXT_FRAME: true,          // 是否用隐藏 iframe 跑站点脚本取文（XHR 拿到的是乱序正文）
    TEXT_FRAME_TIMEOUT: 15000, // 单页 iframe 加载超时 (ms)
    TEXT_UNSCRAMBLE_WAIT: 9000,// 等待站点「段落还原」脚本的最长时间 (ms)，实测约 2.5s
    TEXT_UNSCRAMBLE_POLL: 250, // 上述等待的轮询间隔 (ms)
  };

  /**
   * 速度档位（v1.3.0）
   * 正文始终串行，档位只影响"请求间隔"与"插图并发/超时"，并在遇到 429 时自动降档。
   * turbo: 250~500ms / 8 并发（快，但风控风险最高）
   * fast : 500~900ms  / 6 并发（默认）
   * safe : 800~1500ms / 3 并发（原设计基线）
   */
  const SPEED_PROFILES = {
    turbo: { TEXT_DELAY_MIN: 250, TEXT_DELAY_MAX: 500, IMG_CONCURRENCY: 8, IMG_TIMEOUT: 10000, IMG_RETRY_BACKOFF: 300 },
    fast: { TEXT_DELAY_MIN: 500, TEXT_DELAY_MAX: 900, IMG_CONCURRENCY: 6, IMG_TIMEOUT: 12000, IMG_RETRY_BACKOFF: 400 },
    safe: { TEXT_DELAY_MIN: 800, TEXT_DELAY_MAX: 1500, IMG_CONCURRENCY: 3, IMG_TIMEOUT: 15000, IMG_RETRY_BACKOFF: 600 },
  };

  const SPEED = {
    name: 'fast',
    apply(name) {
      const profile = SPEED_PROFILES[name] || SPEED_PROFILES.fast;
      Object.assign(CONFIG, profile);
      this.name = SPEED_PROFILES[name] ? name : 'fast';
      return this.name;
    },
    /** 命中限速时自动降档，后续请求按标准节奏走 */
    penalize(reason) {
      if (this.name === 'safe') return;
      this.apply('safe');
      console.warn(`[EPUB Downloader] 检测到限速（${reason}），已自动降级为 safe 节奏`);
    },
  };

  /** 正文节奏器：保证相邻两次正文请求的"起点间隔"≥ 档位延迟，且不会重复等待 */
  const Pacer = {
    lastTextAt: 0,
    waits: 0,
    async waitText() {
      const target =
        CONFIG.TEXT_DELAY_MIN + Math.random() * (CONFIG.TEXT_DELAY_MAX - CONFIG.TEXT_DELAY_MIN);
      const gap = this.lastTextAt ? Date.now() - this.lastTextAt : Infinity;
      const wait = target - gap;
      if (wait > 0) {
        this.waits += 1;
        await Utils.sleep(wait, wait);
      }
      this.lastTextAt = Date.now();
    },
    reset() {
      this.lastTextAt = 0;
      this.waits = 0;
    },
  };

  /** 全局插图池：固定并发，边抓正文边下插图，避免整章阻塞 */
  const ImagePool = {
    queue: [],
    active: 0,
    peak: 0,
    add(job) {
      return new Promise((resolve, reject) => {
        this.queue.push({ job, resolve, reject });
        this.pump();
      });
    },
    pump() {
      while (this.active < CONFIG.IMG_CONCURRENCY && this.queue.length > 0) {
        const { job, resolve, reject } = this.queue.shift();
        this.active += 1;
        if (this.active > this.peak) this.peak = this.active;
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.pump();
          });
      }
    },
  };

  // 全局任务锁：同一时间只允许一个分卷在跑，避免多路并发抓取触发站点限速
  let ACTIVE_DOWNLOAD = null;

  // 启动时套用用户选择的速度档位（默认 fast）
  SPEED.apply(GM_getValue('speed_profile', 'fast'));

  /**
   * 静态 PUA 码位兜底映射表（高频基础字种子，仅作完整字典缺项时的兜底）
   * 格式: { "\ue800": "的", "\ue801": "一", ... }
   */
  const BUILTIN_STATIC_PUA_MAP = {
    '\ue800': '的', '\ue801': '一', '\ue802': '是', '\ue803': '了', '\ue804': '我',
    '\ue805': '不', '\ue806': '人', '\ue807': '在', '\ue808': '他', '\ue809': '有',
    '\ue80a': '这', '\ue80b': '个', '\ue80c': '上', '\ue80d': '们', '\ue80e': '来',
    '\ue80f': '到', '\ue810': '时', '\ue811': '大', '\ue812': '地', '\ue813': '为',
    '\ue814': '子', '\ue815': '中', '\ue816': '你', '\ue817': '说', '\ue818': '生',
    '\ue819': '国', '\ue81a': '年', '\ue81b': '着', '\ue81c': '就', '\ue81d': '那',
    '\ue81e': '和', '\ue81f': '要', '\ue820': '她', '\ue821': '出', '\ue822': '也',
    '\ue823': '得', '\ue824': '里', '\ue825': '后', '\ue826': '自', '\ue827': '以',
    '\ue828': '会', '\ue829': '家', '\ue82a': '可', '\ue82b': '下', '\ue82c': '而',
    '\ue82d': '过', '\ue82e': '天', '\ue82f': '去', '\ue830': '能', '\ue831': '对',
    '\ue832': '小', '\ue833': '多', '\ue834': '然', '\ue835': '于', '\ue836': '心',
    '\ue837': '学', '\ue838': '么', '\ue839': '之', '\ue83a': '都', '\ue83b': '好',
    '\ue83c': '看', '\ue83d': '起', '\ue83e': '发', '\ue83f': '当', '\ue840': '没',
  };

  /**
   * 站点 readfont 完整 PUA 字符字典（3500 条，取自 ShqWW/bilinovel-download 的 rubbish_secret_map，
   * 见 https://github.com/ShqWW/bilinovel-download/blob/master/backend/rubbish_secret_map.py）
   *
   * 编码方式：PUA 码位（\uXXXX 转义）与其对应汉字交替排列，
   * 运行时按二元组解析为 { "PUA字符": "汉字" }，避免内嵌 119 KB 的对象字面量。
   * 该字典覆盖站点当前字体码位；若站点更换字体，优先用动态轮廓 Hash 或菜单导入的新字典覆盖。
   */
  const BUILTIN_PUA_DICT_PAIRS =
    "\ue000狼\ue001衅\ue002政\ue003顺\ue004乒\ue005阳\ue006拥\ue00b某\ue00c抓\ue00e签\ue010嘱\ue011馒\ue016梨\ue017剖\ue01a漏\ue01c维\ue01e殴\ue01f惹\ue021崛\ue022哦\ue023面\ue024监\ue025拳\ue026入\ue028拓\ue029扁\ue02a怀\ue02b枣\ue02e产\ue033吹\ue035看\ue036吐\ue038应\ue03b灶\ue03c蛙\ue03d纬\ue03f门\ue040睁\ue041谈\ue043给" +
    "\ue045蹋\ue049大\ue04c湖\ue04d厘\ue052锣\ue053莉\ue054瞪\ue057靶\ue058事\ue059泼\ue05c写\ue062唯\ue064椎\ue066摔\ue068籍\ue06b巾\ue06c襟\ue06d币\ue06e顶\ue06f芬\ue073栈\ue074讨\ue075绷\ue076嚼\ue077拣\ue07a隋\ue07c案\ue07e每\ue07f痴\ue080怯\ue081窝\ue082翻\ue084偶\ue087顽\ue08a窒\ue08b彪\ue08c坠\ue08d秒\ue08e谭\ue08f音" +
    "\ue090包\ue091累\ue092蜓\ue094侨\ue098挪\ue099略\ue09a吠\ue09d诞\ue09e蓉\ue09f广\ue0a1峰\ue0a3岗\ue0a4惟\ue0a7价\ue0a8劝\ue0aa氏\ue0ab弘\ue0ac痢\ue0ad寇\ue0ae纤\ue0b0氨\ue0b1让\ue0b2瑰\ue0b3晃\ue0b4挚\ue0b7踢\ue0b8斩\ue0ba缝\ue0bb铸\ue0c1且\ue0c3合\ue0c4演\ue0c5汗\ue0c7岁\ue0c8购\ue0ce屋\ue0d0庐\ue0d5贡\ue0d7革\ue0d9几" +
    "\ue0da粥\ue0db宪\ue0dd屁\ue0de佣\ue0df置\ue0e0驶\ue0e1庄\ue0e3社\ue0e4灯\ue0e5批\ue0e6烙\ue0e7摹\ue0ea匿\ue0ec暮\ue0ee鹉\ue0f0蒜\ue0f2肾\ue0f4芜\ue0f5嫩\ue0f6盆\ue0fa上\ue0fc野\ue101鸥\ue102属\ue103鄂\ue104根\ue105许\ue106枉\ue107并\ue108津\ue109宛\ue10a阀\ue10b蚓\ue10d销\ue10e赛\ue111竹\ue113腺\ue114涛\ue116威\ue117月" +
    "\ue118鸣\ue119烂\ue11a涕\ue11b滤\ue11f丁\ue120质\ue122厨\ue123禾\ue125镶\ue128毙\ue12a伺\ue12c莹\ue134驼\ue138沪\ue139友\ue13b髓\ue13c汪\ue13f捐\ue144拷\ue145亏\ue147嗦\ue148驴\ue149肪\ue14c群\ue14d屿\ue152输\ue157凹\ue159肚\ue15b杂\ue15e徘\ue15f雏\ue162皮\ue165份\ue167匈\ue169睫\ue16a拯\ue16b掩\ue16d歪\ue16e蕾\ue16f赁" +
    "\ue171澈\ue172瀑\ue173腻\ue174攀\ue175馍\ue176毕\ue179世\ue17d巳\ue17f学\ue182待\ue184鼓\ue187意\ue188权\ue189葱\ue18b冈\ue18c芋\ue190蛤\ue191爽\ue193临\ue196绞\ue197岭\ue19b斜\ue19d熏\ue19e缰\ue19f杆\ue1a1叫\ue1a3刮\ue1a5凑\ue1a6指\ue1a7蜀\ue1a8陆\ue1ac忧\ue1ad灌\ue1af艰\ue1b2易\ue1b3吕\ue1b5佛\ue1b6薛\ue1bb型\ue1bc凉" +
    "\ue1be陵\ue1bf尺\ue1c5拆\ue1c7妮\ue1c8茉\ue1ca喇\ue1cb齿\ue1cc情\ue1ce京\ue1d0芒\ue1d1煎\ue1d4缓\ue1d5勉\ue1d6当\ue1da健\ue1db绑\ue1dc红\ue1dd荤\ue1e3吼\ue1e4杏\ue1e8难\ue1e9院\ue1eb滞\ue1ec似\ue1f2馆\ue1f6蛮\ue1f7草\ue1f9逛\ue1fc沸\ue1fe霎\ue1ff瘦\ue202筒\ue204丝\ue208召\ue20a撼\ue20f靠\ue210淫\ue212击\ue216老\ue217嚎" +
    "\ue218岔\ue21b癣\ue21d既\ue21f欢\ue220揪\ue221俱\ue226蹲\ue227鲫\ue228箫\ue229视\ue22a粘\ue22b磅\ue22c盗\ue22d狂\ue22e滋\ue235振\ue237舶\ue238挨\ue239猎\ue23c喘\ue23d鞠\ue23e冠\ue23f浏\ue240争\ue242膝\ue243帖\ue244虚\ue245踏\ue24a棍\ue24b需\ue24d华\ue24e绪\ue251夺\ue252住\ue253趾\ue254话\ue255装\ue25c城\ue25f迁\ue261咄" +
    "\ue262阶\ue263酝\ue264法\ue265洪\ue267泥\ue268哎\ue269缠\ue26b环\ue26c跳\ue26d张\ue26f曹\ue272兼\ue274犁\ue275处\ue276强\ue27d檀\ue27f跋\ue280遂\ue281希\ue283交\ue284辆\ue285息\ue286玲\ue287淋\ue288险\ue28c捅\ue28d缔\ue290些\ue291愉\ue292呛\ue293饥\ue296伊\ue297突\ue298试\ue29a齐\ue29b蜘\ue29c残\ue29d丈\ue29e具\ue29f柱" +
    "\ue2a0赏\ue2a2届\ue2a3娶\ue2a6珍\ue2a7有\ue2a8埠\ue2ab灾\ue2ac遏\ue2af注\ue2b1快\ue2b4唬\ue2b6乡\ue2b7啄\ue2b8链\ue2b9栏\ue2ba怡\ue2bd歹\ue2bf胳\ue2c1用\ue2c5页\ue2c7焚\ue2c8脐\ue2c9朱\ue2cb盒\ue2cc养\ue2ce困\ue2cf叉\ue2d1碎\ue2d5嫁\ue2d7揣\ue2dd跛\ue2de始\ue2e0苏\ue2e2押\ue2e4索\ue2e5幌\ue2e7灼\ue2e8扩\ue2e9料\ue2eb肖" +
    "\ue2ec划\ue2ee脱\ue2ef衍\ue2f1锤\ue2f4马\ue2f6灿\ue2f7于\ue2f8蜡\ue2fa逞\ue2fe释\ue300排\ue301挖\ue303莫\ue304金\ue306靴\ue307逼\ue308结\ue30a鞭\ue30c垫\ue30e屑\ue311婴\ue314矫\ue31a殷\ue31e摇\ue31f救\ue321川\ue322又\ue323畴\ue325征\ue326揩\ue327港\ue329淆\ue32a汇\ue32c贵\ue32d赔\ue32e锄\ue32f姨\ue330缺\ue332稳\ue333如" +
    "\ue335苍\ue337乓\ue338吾\ue33b挑\ue33d憾\ue33e绿\ue340求\ue341牲\ue342颖\ue344药\ue346沦\ue347峭\ue34b篮\ue34c叠\ue34d墅\ue34f湿\ue351蝗\ue352肩\ue355羡\ue356语\ue357委\ue35d猪\ue35e废\ue361降\ue362禅\ue363条\ue364锌\ue365祥\ue366誉\ue368慧\ue36b足\ue36c夭\ue36e嚣\ue36f癸\ue371筹\ue374棺\ue375琴\ue376坝\ue377辰\ue379今" +
    "\ue37d肝\ue380泛\ue383企\ue389庭\ue38a鼎\ue38c软\ue38e蜕\ue38f茂\ue390埂\ue391称\ue393粱\ue394褪\ue395愁\ue396拒\ue398口\ue399麦\ue3a4乃\ue3a6膜\ue3a8骇\ue3a9钳\ue3ab扎\ue3ac铃\ue3af栋\ue3b0瘩\ue3b1挽\ue3b4跪\ue3b5晚\ue3b6囤\ue3b7橙\ue3b9寄\ue3ba蔓\ue3bd太\ue3be浆\ue3c0枫\ue3c1孔\ue3c3训\ue3c5氧\ue3c8咙\ue3ca皓\ue3cc哗" +
    "\ue3cf攻\ue3d3闹\ue3d4复\ue3d5黑\ue3d6厦\ue3d7泵\ue3d8迄\ue3d9磊\ue3da弹\ue3db鬓\ue3df贝\ue3e1诽\ue3e4祈\ue3e5渲\ue3e8狞\ue3eb吮\ue3ec爸\ue3ee盘\ue3f0靖\ue3f1凌\ue3f3驳\ue3f4蓄\ue3f6域\ue3fa萎\ue3fd愕\ue3fe漓\ue3ff棉\ue400样\ue401歼\ue403方\ue405嘛\ue406网\ue408局\ue409酵\ue40b灸\ue40d搭\ue40e系\ue40f滩\ue410踩\ue411橱" +
    "\ue414恬\ue415俘\ue416蹈\ue418涡\ue419皂\ue41a播\ue41c帘\ue41e刻\ue41f打\ue423掏\ue424盹\ue426磕\ue427材\ue428粮\ue42c燃\ue42e栗\ue42f逾\ue430惑\ue432秧\ue435钓\ue436忆\ue438决\ue43a雷\ue43d嘉\ue43e拙\ue43f涩\ue441存\ue443隅\ue444雀\ue446模\ue447兑\ue448溉\ue44a搂\ue44d丰\ue450捏\ue456冰\ue457镜\ue45a审\ue45b佃\ue45e颓" +
    "\ue45f虎\ue460村\ue461贻\ue462蠢\ue463躺\ue464佐\ue466巩\ue467巴\ue469蝎\ue46a礼\ue46b疹\ue46c财\ue46f碳\ue470星\ue472讹\ue474渴\ue475怪\ue476匹\ue477朵\ue478塔\ue479猜\ue47a轻\ue47b流\ue47c擦\ue47d炸\ue47e吱\ue480冤\ue482垮\ue483库\ue484猛\ue487绘\ue48a姓\ue48c咋\ue48e煮\ue490珠\ue491慷\ue492泊\ue495恒\ue496陶\ue497火" +
    "\ue498青\ue499伏\ue49a雕\ue49b武\ue49c疗\ue49e符\ue49f募\ue4a0氓\ue4a2迹\ue4a7痰\ue4a9怕\ue4aa画\ue4ab奸\ue4ad象\ue4ae急\ue4b0瓢\ue4b1沥\ue4b3杠\ue4b7悉\ue4b8埋\ue4b9披\ue4ba坪\ue4c0混\ue4c3娇\ue4c5绒\ue4c6帮\ue4c7承\ue4c8筑\ue4c9知\ue4cb落\ue4cc县\ue4cd浸\ue4cf戳\ue4d6坟\ue4d7斑\ue4d8瓷\ue4d9勋\ue4db浑\ue4e1爷\ue4e2史" +
    "\ue4e3吟\ue4e5典\ue4e6架\ue4e7滚\ue4e8食\ue4e9恶\ue4ed焦\ue4ee葵\ue4f0唠\ue4f4丫\ue4f6董\ue4f7碘\ue4f8斥\ue4fa藐\ue4fd与\ue4fe侦\ue500贸\ue502闷\ue504贞\ue505贯\ue506倾\ue507绰\ue509湾\ue50a逊\ue50f溯\ue510赴\ue512槛\ue515初\ue517拖\ue519莱\ue51a恭\ue51d脸\ue51f柜\ue520憨\ue521赞\ue522肴\ue524肥\ue525详\ue528娟\ue529扯" +
    "\ue52a碧\ue52c罐\ue52d童\ue52e凯\ue52f关\ue532严\ue533翅\ue538歌\ue539岂\ue53a盐\ue53b唤\ue53c毒\ue53d向\ue53e抬\ue53f纷\ue540减\ue541昆\ue542泡\ue547述\ue549叁\ue54c响\ue54d姑\ue550昨\ue554号\ue555菌\ue557刃\ue559真\ue55a球\ue561牌\ue562阴\ue563晋\ue565概\ue566罩\ue567捻\ue56a幅\ue56b禄\ue56c荒\ue56e夫\ue56f商\ue570澜" +
    "\ue577虫\ue579杖\ue57b档\ue57c炎\ue57e霸\ue57f针\ue580幽\ue581惧\ue582荔\ue583肢\ue585缆\ue589陈\ue58a吻\ue58b抱\ue58c状\ue58d也\ue58f姜\ue590胚\ue591愚\ue593纪\ue594偏\ue597迫\ue598曾\ue599牡\ue59b谣\ue59d永\ue59f层\ue5a1傻\ue5a3善\ue5a4夸\ue5a5忠\ue5a8敏\ue5a9宫\ue5ab茬\ue5ad南\ue5ae往\ue5af崇\ue5b0扭\ue5b1汁\ue5b2疼" +
    "\ue5b3怔\ue5b7觉\ue5b9夹\ue5ba细\ue5be幕\ue5bf渣\ue5c2款\ue5c3番\ue5c4乘\ue5c5午\ue5c9截\ue5ca各\ue5cd陡\ue5d0单\ue5d1霜\ue5d2鸵\ue5d3沧\ue5d8假\ue5d9北\ue5da抄\ue5dc您\ue5dd那\ue5df择\ue5e1导\ue5e2拍\ue5e3挺\ue5e6莲\ue5e7封\ue5e8筐\ue5ea艇\ue5eb履\ue5ec消\ue5ef魏\ue5f2溶\ue5f3揽\ue5f4木\ue5f5巅\ue5fb垒\ue5ff隔\ue601后" +
    "\ue602池\ue605雪\ue606谤\ue609己\ue60a边\ue60b诵\ue60e搀\ue60f仑\ue610题\ue616辣\ue617框\ue618叙\ue619陪\ue61a誊\ue61c侄\ue61e到\ue620笙\ue621核\ue622肤\ue624冒\ue628乖\ue62b重\ue62c物\ue62f卵\ue630荐\ue631袜\ue633脑\ue634蕉\ue635循\ue63b搔\ue63d色\ue63f尉\ue641俭\ue642列\ue643毅\ue644焊\ue646菠\ue647兢\ue648树\ue64a乳" +
    "\ue64b缎\ue64d肃\ue650雇\ue651底\ue652艺\ue653宦\ue656嗓\ue658扣\ue659脾\ue65a箩\ue65b君\ue65c衣\ue65d估\ue65e卧\ue660湃\ue661垢\ue664剥\ue667矿\ue66a亡\ue66b堕\ue66d绣\ue66e令\ue670肇\ue671炊\ue674篓\ue676姐\ue678煽\ue67c渤\ue67d耳\ue67e浩\ue681稠\ue682沽\ue683毁\ue686驱\ue68d幻\ue68e卉\ue68f则\ue690炉\ue691赢\ue692钞" +
    "\ue694奥\ue695戒\ue698斌\ue69c叼\ue69e本\ue69f适\ue6a0或\ue6a2窍\ue6a3船\ue6a5荧\ue6a6矣\ue6a8蒙\ue6a9铲\ue6aa闰\ue6ac加\ue6ad省\ue6ae巨\ue6af者\ue6b0呕\ue6b4屹\ue6b5玄\ue6b6瓶\ue6b8澄\ue6b9喝\ue6bc畸\ue6bd忙\ue6c0颤\ue6c1八\ue6c3糕\ue6c4阐\ue6c5钱\ue6c6崖\ue6c7铛\ue6cb主\ue6cc迪\ue6cf化\ue6d2饿\ue6d3读\ue6d4很\ue6d5埃" +
    "\ue6d6贰\ue6da壶\ue6dc吨\ue6dd疫\ue6de谍\ue6df兴\ue6e0供\ue6e1雳\ue6e2诊\ue6e3策\ue6e5轩\ue6ea糯\ue6ed谎\ue6ee至\ue6f0请\ue6f1穷\ue6f4目\ue6f8论\ue6fa蚪\ue6fc古\ue6fd搅\ue701垂\ue702硫\ue703尔\ue704示\ue705宰\ue709聪\ue70a席\ue70b高\ue70d馈\ue70e触\ue70f旗\ue710基\ue713按\ue714矗\ue715富\ue716绍\ue719候\ue71b亭\ue71c挟" +
    "\ue720铝\ue721你\ue727躬\ue728喧\ue729桨\ue72b挂\ue72d唾\ue731袱\ue732蔼\ue734榆\ue735雅\ue736夏\ue738煞\ue739炮\ue73a耐\ue73b忌\ue73d掠\ue73f访\ue740醒\ue741厉\ue743仔\ue745蠕\ue746螺\ue747馅\ue748虏\ue749臣\ue74a谴\ue74c俄\ue74e遣\ue74f愧\ue750烹\ue751锥\ue752烧\ue755帚\ue757毡\ue758抹\ue759谋\ue75a葡\ue75c辱\ue75d去" +
    "\ue75e稍\ue760冲\ue761形\ue763鬼\ue765僚\ue769融\ue76b闪\ue76d拉\ue771扔\ue777标\ue778搓\ue779棋\ue77a损\ue77c戈\ue77e浊\ue77f二\ue780陌\ue782寺\ue783拦\ue784证\ue785记\ue786雨\ue787时\ue788刑\ue789惜\ue78a线\ue78c卒\ue798垃\ue799弥\ue79e忽\ue7a0侮\ue7a1团\ue7a4秽\ue7a9肉\ue7ab抛\ue7ac板\ue7ad萨\ue7ae痊\ue7af贬\ue7b0忿" +
    "\ue7b3普\ue7b4宅\ue7b5府\ue7b7创\ue7b8芭\ue7b9错\ue7ba滑\ue7bb窜\ue7bc寒\ue7bd觅\ue7be瑙\ue7c0甜\ue7c1倦\ue7c2裸\ue7c3匾\ue7c5恤\ue7c6窿\ue7c9颜\ue7ca榄\ue7cc卜\ue7cd伦\ue7d1翔\ue7d4族\ue7d9山\ue7db剑\ue7de隙\ue7e0势\ue7e1杉\ue7e4虾\ue7e5女\ue7f4乾\ue7f5淘\ue7f7筷\ue7f9媚\ue7fa悬\ue7fc催\ue7fd升\ue7fe术\ue800惭\ue801银" +
    "\ue803勾\ue804麻\ue806骤\ue807动\ue809岛\ue80a塑\ue80d追\ue80f燕\ue810盖\ue811糊\ue813坎\ue814兜\ue867胧\ue86a烘\ue86b伙\ue86c辟\ue86e蔚\ue86f胡\ue870烤\ue872憎\ue873赂\ue874下\ue876酗\ue879橘\ue87a佑\ue87b昧\ue87d睬\ue880悲\ue882芦\ue885捺\ue886函\ue887回\ue889蛾\ue88b忍\ue88c妥\ue88f辙\ue890碟\ue892锹\ue896施\ue89c得" +
    "\ue89d晓\ue8a0街\ue8a1牵\ue8a4湘\ue8a7泌\ue8ab厚\ue8ac词\ue8ad酪\ue8ae允\ue8af浅\ue8b0霄\ue8b2煤\ue8b3帆\ue8b6气\ue8b7传\ue8b8量\ue8ba园\ue8bd槐\ue8be妄\ue8bf队\ue8c0瞭\ue8c2喊\ue8c5婪\ue8c7紊\ue8c9液\ue8ca氢\ue8cb肺\ue8cc卿\ue8cd拇\ue8d0禽\ue8d2剧\ue8d4仇\ue8d5润\ue8d7扼\ue8d8滥\ue8da嗅\ue8db稻\ue8dc皇\ue8e1爱\ue8e3然" +
    "\ue8e4蚤\ue8e5胆\ue8e6剔\ue8e7它\ue8e8臭\ue8eb仲\ue8ec九\ue8ed替\ue8ee议\ue8f0行\ue8f4搏\ue8f6勿\ue8f7袖\ue8fb栓\ue8fd筝\ue8fe杀\ue8ff拟\ue900畏\ue902豚\ue906深\ue907迭\ue90d四\ue90f虽\ue910祸\ue913拜\ue915嘶\ue916尸\ue918更\ue91a辈\ue91c是\ue91d茅\ue91e患\ue91f偎\ue921勇\ue922琳\ue925御\ue927檬\ue928思\ue92a苗\ue92b堰" +
    "\ue92c直\ue92d活\ue92e付\ue92f腮\ue931即\ue933矾\ue934迷\ue935营\ue936怨\ue937缅\ue938践\ue939魔\ue93d找\ue944伞\ue945桩\ue949以\ue94b盲\ue94d聆\ue94e般\ue952敬\ue953瘫\ue956际\ue957俩\ue959眨\ue95a斋\ue95c汰\ue95d腰\ue960室\ue961调\ue964帅\ue965区\ue966执\ue967耿\ue968了\ue96b矢\ue96e疙\ue96f谬\ue970亚\ue971叽\ue972途" +
    "\ue974棒\ue975拨\ue976蝙\ue977铜\ue979叨\ue97c颁\ue97f狡\ue980杭\ue984共\ue985个\ue987凝\ue988凭\ue989峻\ue98a横\ue98e赵\ue98f荣\ue990人\ue991奏\ue992贿\ue997繁\ue999稚\ue99a双\ue99d纯\ue99e闯\ue9a0稼\ue9a5律\ue9a6楷\ue9a7倍\ue9a9副\ue9aa店\ue9ab窑\ue9ae在\ue9af呆\ue9b0内\ue9b3瞧\ue9b4傅\ue9b7缚\ue9be窥\ue9bf沿\ue9c0戚" +
    "\ue9c3聋\ue9c5骡\ue9c7懊\ue9c9扛\ue9ca茄\ue9cb碍\ue9ce侍\ue9d3胞\ue9d4聊\ue9d5颈\ue9d6练\ue9d7折\ue9d9竖\ue9da烛\ue9dd弱\ue9de巧\ue9e0棘\ue9e1智\ue9e2泰\ue9e3殃\ue9e4涧\ue9e5憔\ue9e8柒\ue9ea补\ue9eb脚\ue9ec惩\ue9ee妇\ue9f0饲\ue9f2廷\ue9f3匪\ue9f4束\ue9f6采\ue9fa放\ue9fb构\ue9fc囚\ue9ff乍\uea04占\uea05巍\uea07说\uea09罪" +
    "\uea0a裤\uea0c跌\uea0e站\uea0f吓\uea10现\uea11蛋\uea12豆\uea13所\uea19祟\uea1b苹\uea1c戴\uea1d茁\uea1e割\uea21祭\uea22粟\uea23淀\uea25沛\uea27电\uea28烈\uea29菜\uea2a糠\uea2f游\uea31冉\uea33羹\uea38警\uea39吧\uea3a衙\uea40骑\uea41舅\uea42录\uea43呀\uea46竭\uea4b蚊\uea50解\uea51矩\uea52磨\uea53藉\uea54朴\uea55泳\uea57竣" +
    "\uea58桦\uea5a椿\uea5b平\uea5d笛\uea61吉\uea63伍\uea67碾\uea69透\uea6b失\uea6d器\uea6f膏\uea70瞻\uea71厢\uea75罢\uea77垄\uea7a捌\uea7b余\uea7d蝇\uea7e寨\uea80央\uea81借\uea82梳\uea83圣\uea84妓\uea86囊\uea87留\uea88饰\uea8b凤\uea8c锡\uea8d冥\uea90庞\uea91男\uea94恢\uea99民\uea9b祷\uea9c运\uea9d斤\ueaa2柬\ueaa3懂\ueaa6嗽" +
    "\ueaa7徐\ueaa8宿\ueaa9帕\ueaac旨\ueaad粤\ueaae囱\ueaaf整\ueab0熙\ueab1洲\ueab2纫\ueab3狗\ueab4推\ueab5验\ueab6努\ueab7坡\ueab9溅\ueabb薯\ueabc踪\ueabd聂\ueabe闭\ueac1剪\ueac2督\ueac3粗\ueac4阔\ueac5症\ueac9鸦\ueacd缘\ueace连\uead2趣\uead4佩\uead5脂\uead6朗\uead7孤\uead8锁\uead9欧\ueadb朦\ueadd终\ueade涉\ueadf党\ueae0塘" +
    "\ueae4妖\ueae5匀\ueae6颗\ueae9侣\ueaea期\ueaef捂\ueaf0惕\ueaf1秋\ueaf5赠\ueafa廉\ueafc遮\ueafd地\ueafe走\ueaff疚\ueb02舔\ueb03们\ueb05廊\ueb07璧\ueb09萝\ueb0a纸\ueb0b龙\ueb0f频\ueb10端\ueb12他\ueb13兆\ueb14啦\ueb15节\ueb16鳍\ueb17哄\ueb1b铁\ueb1d彼\ueb1e腕\ueb1f谓\ueb20耸\ueb21登\ueb23务\ueb25亥\ueb27拎\ueb29予\ueb2d孝" +
    "\ueb30奇\ueb31况\ueb33馨\ueb34及\ueb39溺\ueb3a肛\ueb3d婚\ueb3e饼\ueb3f仆\ueb41除\ueb44宏\ueb46臼\ueb48丸\ueb4a丘\ueb4b骏\ueb4c休\ueb4d梆\ueb4e短\ueb4f贴\ueb50痘\ueb52咱\ueb53绝\ueb57屏\ueb59懒\ueb5b胸\ueb5c媳\ueb5d跑\ueb5e闸\ueb5f度\ueb62嘻\ueb64达\ueb65设\ueb68黎\ueb69喉\ueb6a锋\ueb6d盯\ueb6e蜒\ueb6f敛\ueb71隐\ueb73台" +
    "\ueb76因\ueb78命\ueb79六\ueb7a伶\ueb7e楚\ueb80拿\ueb81亢\ueb82灵\ueb84蛇\ueb87恰\ueb88锈\ueb8a做\ueb8b撰\ueb8c姆\ueb8e哟\ueb8f舍\ueb90渐\ueb91嫂\ueb92谁\ueb93念\ueb94界\ueb95醋\ueb96顾\ueb97十\ueb9a缤\ueb9c舟\ueb9f惊\ueba0尖\ueba4琢\ueba5漂\ueba6尬\uebaa文\uebab拂\uebac弟\uebad恕\uebae悟\uebb4宾\uebb7玉\uebb9祀\uebba翼" +
    "\uebbb秩\uebbc葬\uebc0体\uebc1搞\uebc4撤\uebc5弄\uebc6傍\uebc7秘\uebc8址\uebc9耍\uebcb惦\uebcc馋\uebcd慎\uebce啥\uebcf渊\uebd2臀\uebd4澳\uebd6未\uebd7儒\uebd9乔\uebe2赚\uebe4讥\uebe5纠\uebe6微\uebe7程\uebe8吭\uebef旱\uebf0凶\uebf1柔\uebf3要\uebf4名\uebf5涯\uebf6病\uebf7辩\uebfa藏\uebfc翰\uebfe樱\uebff洞\uec00玛\uec02亦" +
    "\uec03鳄\uec04掰\uec07瞳\uec08空\uec09啸\uec0a迢\uec0b苛\uec0c会\uec0d秤\uec0f吝\uec12锯\uec16恩\uec1b勒\uec1c孽\uec1d收\uec21把\uec25堆\uec26蹦\uec27抖\uec28印\uec29绩\uec2b超\uec2c代\uec2d萧\uec2e员\uec30吴\uec31芽\uec32鹰\uec33忱\uec35烫\uec36唱\uec37佳\uec38轰\uec39颅\uec3b眠\uec40妨\uec43饵\uec45缕\uec46仪\uec47沃" +
    "\uec48姚\uec4a哺\uec4c炬\uec52值\uec53纳\uec58起\uec59茎\uec5a倔\uec5c牧\uec5f窄\uec60丽\uec61同\uec64玩\uec68仙\uec6a颇\uec6b汉\uec6d清\uec70梦\uec73她\uec75榔\uec76叔\uec77粒\uec78床\uec7a搁\uec7c来\uec7e浓\uec80呈\uec81膊\uec83种\uec85棠\uec86敷\uec88芝\uec89相\uec8a校\uec8b责\uec8c慌\uec8d庸\uec8f枚\uec95谚\uec96资" +
    "\uec97淑\uec99闻\uec9a钝\uec9d遭\uec9f蝌\ueca0冶\ueca2犹\ueca3避\ueca4刁\ueca5裕\ueca6携\ueca7敢\ueca8圈\uecaa汽\uecab尧\uecad泪\uecae甫\uecaf漠\uecb0苑\uecb1显\uecb2管\uecb3膨\uecb6匣\uecb7侧\uecb8掌\uecba乙\uecbb尽\uecc1劈\uecc2昔\uecc4鲍\uecc5众\uecc7缭\uecca阎\ueccb喂\ueccc脊\ueccd枝\uecce辅\ueccf衡\uecd2岸\uecd4英" +
    "\uecd7压\uecd9瞅\uecda讳\uecdb片\uecdc切\uecde克\uecdf果\uece0为\uece3依\uece4丙\uece5巫\uece7撬\uece8客\uece9颂\uecea徽\ueced射\uecee弧\uecf0杨\uecf1一\uecf3涤\uecf5悄\uecf6柠\uecf8兵\uecf9卢\uecfa离\uecfb就\uecfc韭\uecfd犀\uecfe匕\ued00淌\ued02娥\ued03费\ued06自\ued07恍\ued08尘\ued0b逐\ued0e蒋\ued10墙\ued11寂\ued12此" +
    "\ued13辜\ued14遗\ued15配\ued17净\ued18尾\ued1b撇\ued1c毛\ued1d薇\ued1f惋\ued20子\ued21奉\ued27诱\ued28迎\ued29距\ued2a末\ued2d招\ued2e赘\ued2f拼\ued30垦\ued31绎\ued34呢\ued35支\ued36殉\ued37互\ued38痪\ued39西\ued3c私\ued3d冯\ued40摩\ued41衷\ued42屠\ued43两\ued44妻\ued45逢\ued47懈\ued48辗\ued4a栅\ued4b朝\ued4e涌\ued4f春" +
    "\ued50战\ued51另\ued53藻\ued55仰\ued56债\ued57胶\ued58雹\ued59檐\ued5b耽\ued5c厕\ued5e拽\ued5f售\ued60卯\ued61豁\ued62鸟\ued63鸯\ued66钠\ued67违\ued6b安\ued6d独\ued6e郑\ued6f涂\ued71右\ued72箕\ued73套\ued74怖\ued75震\ued76霞\ued77坊\ued78陨\ued79插\ued7b疾\ued7c谦\ued82兹\ued84曼\ued85士\ued86选\ued87碑\ued8b还\ued8c裂" +
    "\ued90织\ued94宁\ued95侵\ued97何\ued99曝\ued9a盔\ued9c望\ued9f狸\ueda2糙\ueda5酷\ueda6捕\uedab柄\uedad署\uedaf暂\uedb4榨\uedb5鲸\uedb6圃\uedb7而\uedb9魁\uedba蚂\uedbc教\uedbf司\uedc1蒲\uedc2眼\uedc4熬\uedc6换\uedc7千\uedc8涮\uedcb锦\uedcc亮\uedd0闽\uedd1漾\uedd2拐\uedd3生\uedd4杜\uedd5冗\uedd6诫\ueddb抠\ueddc计\ueddd睹" +
    "\uede3李\uede4鳞\uede7公\uede8瞄\uede9婆\uedeb疤\uedee腊\uedf1惠\uedf3哆\uedf7季\uedf9办\uedfa前\uedfb撞\uedfd钾\uedfe褐\uee00敲\uee01宴\uee03壬\uee04寞\uee05泽\uee06蚕\uee07停\uee08远\uee0c报\uee0e延\uee0f硬\uee10寻\uee11俐\uee15胖\uee18据\uee1d肋\uee1e刹\uee20娘\uee25河\uee26受\uee28驮\uee2a崭\uee30咒\uee32拾\uee37帷" +
    "\uee3a寝\uee3c赫\uee3d龄\uee3e先\uee3f卖\uee42僵\uee43鱼\uee45格\uee4c范\uee4f峨\uee50魅\uee53鸭\uee54闺\uee56俗\uee57迈\uee58捞\uee59姥\uee5c寡\uee5e历\uee5f悼\uee60耙\uee61着\uee62职\uee68旋\uee69狈\uee6a嵌\uee6b揍\uee6e婶\uee6f砂\uee71鲜\uee73蓝\uee74丑\uee75刷\uee76东\uee78酱\uee7a惰\uee7b酣\uee7c郎\uee81堂\uee82奈" +
    "\uee83治\uee84虑\uee85瞒\uee86全\uee8a转\uee8b派\uee8c血\uee8d胰\uee8f序\uee90科\uee91专\uee93冻\uee95刘\uee97磁\uee9a蜗\uee9f赶\ueea2尤\ueea4啡\ueea5脏\ueea6鹿\ueea7左\ueea8使\ueea9票\ueeaa牛\ueeab缀\ueeac扑\ueead通\ueeae孩\ueeb1小\ueeb3滴\ueeb4兔\ueeb5竿\ueeb7捶\ueeba充\ueebb特\ueebc桔\ueebe填\ueebf掂\ueec2图\ueec4益" +
    "\ueec6撒\ueec7魄\ueec8趴\ueec9傲\ueecb岩\ueecf戎\ueed0纵\ueed2腾\ueed3其\ueed5卑\ueed6哲\ueed7喷\ueed8松\ueed9衔\ueeda贱\ueedb白\ueedc娜\ueee3布\ueee5虹\ueee6爬\ueee9逝\ueeea诀\ueeeb花\ueeef感\ueef1籽\ueef3壹\ueef4森\ueef5赖\ueef6件\ueef7析\ueef8镑\ueef9爪\ueefa匙\ueefb莺\ueefd趟\ueefe豹\uef01波\uef02盼\uef03洋\uef05凿" +
    "\uef08剿\uef0b贪\uef0c瘪\uef0f撩\uef10巷\uef11跤\uef12纲\uef13成\uef14竟\uef17菱\uef1c抒\uef1d厂\uef1e赦\uef1f项\uef21壮\uef22郭\uef24精\uef25浴\uef26叛\uef27艾\uef28堤\uef29鸽\uef2b神\uef2c税\uef2f咨\uef30琉\uef34握\uef35疆\uef39官\uef3a舒\uef3c蹬\uef3e毯\uef3f迅\uef41剂\uef44墟\uef45墩\uef46勤\uef48盾\uef49鸳\uef4a溢" +
    "\uef4b涝\uef4d抚\uef4e烁\uef4f邀\uef50俺\uef51炫\uef52耻\uef54碱\uef55问\uef56垛\uef59近\uef5b将\uef5d殿\uef5e怠\uef62半\uef63德\uef65舌\uef67告\uef6b蕴\uef6d踊\uef70悯\uef72盛\uef73肌\uef79鞍\uef7f椰\uef80硕\uef81轿\uef82谨\uef84鉴\uef85蟀\uef86吩\uef89蔑\uef8e络\uef91耀\uef92娱\uef93啼\uef94溪\uef95剩\uef96发\uef9b糟" +
    "\uef9c沁\uef9d旷\uef9e仁\uef9f妈\uefa0棕\uefa1泞\uefa3绳\uefa4赐\uefa5柳\uefa7乌\uefa9被\uefaa杯\uefab晶\uefac烟\uefad多\uefae已\uefaf渠\uefb1屎\uefb2陷\uefb3蜻\uefb6逆\uefb7阻\uefb9硅\uefbb秉\uefbc臊\uefbe申\uefbf立\uefc1改\uefc3随\uefc4心\uefc5铐\uefc7增\uefc8咸\uefc9含\uefcd愈\uefce兽\uefcf旅\uefd2长\uefd4塌\uefd5约" +
    "\uefd7斯\uefd8祖\uefd9讲\uefdd淮\uefde素\uefdf天\uefe0甸\uefe1最\uefe3引\uefe7燥\uefe8沈\uefe9寥\uefea噪\uefeb碌\uefee桂\uefef摸\ueff3灭\ueff4抵\ueff5酥\ueff7啃\ueff8邻\ueff9蟆\ueffb统\uefff渔\uf000坏\uf001狱\uf002由\uf003僻\uf006功\uf007喳\uf009笔\uf00a豪\uf00b镐\uf00d宙\uf00e祠\uf00f茧\uf010里\uf012隶\uf013侠\uf014哪" +
    "\uf015从\uf017油\uf018唇\uf01a道\uf01b芯\uf01c悠\uf01f厌\uf020甘\uf023桃\uf024坯\uf025涵\uf027苔\uf028庚\uf029盏\uf02a激\uf02d簇\uf030逃\uf031锅\uf034卸\uf039水\uf03b帽\uf03c桌\uf03f舰\uf042修\uf043曲\uf045贺\uf047掀\uf048饶\uf04a炕\uf04b肘\uf04c操\uf04d风\uf050伴\uf051瘾\uf052晰\uf055译\uf056卦\uf057梯\uf059疮\uf05b蒂" +
    "\uf05e托\uf05f丐\uf063篇\uf065的\uf066叩\uf067点\uf068跺\uf06a韧\uf06b唁\uf06f潜\uf073逸\uf074芳\uf076梭\uf077捷\uf079舞\uf07a咽\uf07b诲\uf07c类\uf07d挠\uf07e兄\uf07f徙\uf080咪\uf081跨\uf083谐\uf087茶\uf089潮\uf08a干\uf08b非\uf08c浙\uf08d旺\uf08f奶\uf092异\uf093螃\uf094香\uf097师\uf098例\uf099蛛\uf09e菊\uf09f槽\uf0a2梅" +
    "\uf0a4黄\uf0a5利\uf0a6虐\uf0a8启\uf0aa吃\uf0ac帜\uf0ad辖\uf0ae赎\uf0af日\uf0b2秦\uf0b5啤\uf0b6碰\uf0b8贷\uf0b9菲\uf0bb巡\uf0be痛\uf0bf簧\uf0c0塞\uf0c5投\uf0c9焕\uf0cb赌\uf0cd甩\uf0d0蚌\uf0d2膀\uf0d4挡\uf0d5辞\uf0d8慕\uf0db荷\uf0dd扳\uf0de滇\uf0e0梁\uf0e3寸\uf0e8晨\uf0e9百\uf0ea卤\uf0ed皿\uf0ee源\uf0ef皖\uf0f0脓\uf0f1级" +
    "\uf0f2腐\uf0f3玫\uf0f4暖\uf0f6崩\uf0f7契\uf0f8父\uf0f9吏\uf0fa腥\uf0fb身\uf0fe栽\uf100隧\uf101拢\uf103啊\uf107优\uf109蚯\uf10b穴\uf10d汝\uf10e肠\uf110便\uf111嘴\uf112牙\uf114幸\uf115订\uf116酸\uf119秃\uf11c咬\uf11d淳\uf11e可\uf123移\uf125狰\uf129睛\uf12a参\uf12b貌\uf12c林\uf12e茵\uf130励\uf132防\uf135弛\uf137乎\uf138咏" +
    "\uf13b越\uf13d恨\uf13e覆\uf13f吸\uf142著\uf144工\uf145泉\uf148勃\uf149烦\uf14d彤\uf14e吆\uf154凸\uf156掉\uf158土\uf15b柴\uf15c倡\uf162揭\uf164婿\uf165艘\uf166堡\uf168穗\uf169育\uf16c歧\uf16d倒\uf16e谊\uf171王\uf172品\uf173簿\uf174怜\uf175敞\uf176位\uf178奋\uf17a诺\uf17b联\uf181镀\uf182饺\uf184诚\uf186持\uf189歉\uf18a豌" +
    "\uf18d罕\uf18f瞩\uf192寓\uf193蔽\uf194赤\uf197援\uf198呼\uf199痒\uf19b狮\uf19c扬\uf19f举\uf1a0焉\uf1a1货\uf1a2墨\uf1a6识\uf1aa搜\uf1ab掷\uf1af闲\uf1b0萤\uf1b2沉\uf1b5亲\uf1b6汞\uf1b7田\uf1b8集\uf1ba确\uf1bb狐\uf1bc式\uf1bd综\uf1be见\uf1bf凄\uf1c0穿\uf1c1胜\uf1c3须\uf1c6奖\uf1c7痕\uf1c9藕\uf1cc壤\uf1cd鼠\uf1ce偿\uf1d0扰" +
    "\uf1d2醉\uf1d3昌\uf1d4拱\uf1d5辑\uf1d8镇\uf1dc进\uf1de钧\uf1df渝\uf1e2藤\uf1e3诈\uf1e4砸\uf1e6无\uf1e8掐\uf1e9听\uf1eb飞\uf1ec擅\uf1ed粪\uf1ee评\uf1ef讯\uf1f0坛\uf1f1芥\uf1f2鲤\uf1f3黔\uf1f5厅\uf1f6伯\uf1f7数\uf1f8映\uf1fb串\uf1fc逻\uf1fd妹\uf1fe戊\uf201硝\uf203邦\uf205钟\uf207漱\uf20b惶\uf20d刚\uf20e炼\uf210三\uf212早" +
    "\uf213紫\uf214姊\uf216丧\uf21a信\uf21b守\uf21c间\uf21d悔\uf21f缩\uf220雾\uf221侥\uf225极\uf227什\uf228躁\uf22a宗\uf22c堵\uf22e夯\uf22f唐\uf232峡\uf235杰\uf236七\uf238不\uf239赋\uf23b盈\uf23e拴\uf241柑\uf245蔡\uf246班\uf248别\uf249误\uf24a鼻\uf24c皱\uf24d掺\uf24e汛\uf252猬\uf253仓\uf255疏\uf257妙\uf25a课\uf25b哥\uf25c儿" +
    "\uf25f琼\uf261五\uf262蚣\uf264哑\uf265雁\uf267头\uf269晒\uf26b接\uf26d讽\uf270簸\uf272乱\uf274秆\uf276袋\uf277宣\uf279路\uf27a啪\uf27b笨\uf27c总\uf27d扫\uf27e尝\uf281续\uf282阁\uf284欺\uf285唉\uf287箱\uf288钩\uf28a岳\uf28b哀\uf28c免\uf290唧\uf292撑\uf293潭\uf295效\uf297医\uf298绕\uf299挣\uf29a窗\uf29c咳\uf29e棚\uf29f氛" +
    "\uf2a1菩\uf2a2睐\uf2a3晦\uf2a5邑\uf2a7蹂\uf2ab橄\uf2ad咖\uf2ae乞\uf2af驰\uf2b4影\uf2b5均\uf2b6彩\uf2b9却\uf2ba嘀\uf2bc书\uf2bd铺\uf2be制\uf2bf丹\uf2c0剃\uf2c1这\uf2c2检\uf2c4送\uf2c6备\uf2c7义\uf2c8扇\uf2c9腹\uf2cd叶\uf2ce石\uf2d2境\uf2d3焰\uf2d4邪\uf2d6踱\uf2db额\uf2dd括\uf2df梧\uf2e0脆\uf2e4军\uf2e5舱\uf2e6册\uf2e7柏" +
    "\uf2e8叭\uf2e9刊\uf2eb葛\uf2ec宵\uf2ed奢\uf2f0岖\uf2f1瘤\uf2f5想\uf2f6蹭\uf2f8没\uf2f9淹\uf2fb尴\uf2fd荫\uf304骄\uf306鄙\uf30a晾\uf30b驯\uf30c继\uf310康\uf311敦\uf312市\uf314背\uf315铅\uf316斗\uf317能\uf318贾\uf319痹\uf31a萄\uf31d取\uf31f灰\uf320洗\uf323侈\uf324庇\uf326轮\uf328纽\uf329扒\uf32a嗜\uf32b擂\uf32c熊\uf32d添" +
    "\uf32e附\uf330嚷\uf332积\uf335柿\uf336遍\uf337租\uf338态\uf339宝\uf33a介\uf33f坑\uf340坚\uf341遥\uf342原\uf346淤\uf348讼\uf34a断\uf34b滔\uf34d驾\uf34e贤\uf352造\uf353浪\uf354宠\uf355呵\uf358墓\uf361筏\uf362奴\uf364场\uf368擎\uf36a默\uf36c云\uf36f崎\uf371萌\uf372沟\uf376坦\uf377挫\uf378鹅\uf37c版\uf37f钻\uf381骗\uf382竞" +
    "\uf383翠\uf384桑\uf385容\uf386海\uf387旦\uf389答\uf38b龟\uf38c雌\uf38d尼\uf38f国\uf390亩\uf391瓜\uf392稿\uf394暇\uf395颊\uf396乐\uf398畜\uf39c旧\uf39d诡\uf3a0疑\uf3a1笼\uf3a2若\uf3a3故\uf3a4祝\uf3a7完\uf3a8贩\uf3a9暑\uf3aa察\uf3ad像\uf3ae猿\uf3af炒\uf3b0蝉\uf3b2篱\uf3b4井\uf3b5萍\uf3b6咕\uf3b7呜\uf3b8涨\uf3b9腿\uf3bb锚" +
    "\uf3bd摄\uf3c1蝠\uf3c3癌\uf3c7霹\uf3cb少\uf3ce爵\uf3d2昭\uf3d3仿\uf3d4键\uf3d5轨\uf3d6挥\uf3d8脉\uf3d9性\uf3da预\uf3db辽\uf3e0欠\uf3e1乏\uf3e2薪\uf3e4爹\uf3e6钢\uf3e8协\uf3e9辐\uf3ea睦\uf3eb热\uf3ec买\uf3ed第\uf3ee骂\uf3f3胎\uf3f5轴\uf3f6惨\uf3fa跷\uf3fb洼\uf3fc恃\uf400愤\uf401诸\uf402算\uf405沫\uf406负\uf408旬\uf409弃" +
    "\uf40a琅\uf40b讶\uf40e褒\uf412赣\uf414毫\uf415馁\uf416倚\uf417劣\uf418锰\uf419米\uf41a呐\uf41c脯\uf41d蟹\uf421玖\uf424俊\uf425媒\uf427驹\uf42a步\uf42b卓\uf42c衫\uf42f伪\uf430吊\uf431章\uf433堪\uf434鹏\uf437洒\uf438悖\uf439庆\uf43a弯\uf43b渗\uf43c隘\uf43d罗\uf43e中\uf440家\uf442煌\uf443规\uf444铭\uf446迂\uf447粹\uf449过" +
    "\uf44b零\uf44d对\uf44f甲\uf450分\uf454仍\uf456椭\uf459明\uf45b邓\uf45d慈\uf45f培\uf462帝\uf465冷\uf466宇\uf467绽\uf468绅\uf469洛\uf46b幼\uf46c组\uf46e窖\uf46f获\uf470霉\uf471餐\uf472担\uf474匆\uf475榕\uf477钥\uf47b摊\uf47c衰\uf47d坷\uf47f氮\uf480捉\uf481睡\uf482瞬\uf484憋\uf486股\uf488晴\uf489贮\uf48b桶\uf492刨\uf495芙" +
    "\uf497狭\uf498瘟\uf499志\uf49d径\uf49f纱\uf4a1慰\uf4a4芹\uf4a5手\uf4a6建\uf4a8浮\uf4a9漫\uf4ac暴\uf4ae忘\uf4af首\uf4b2捣\uf4b3矮\uf4b4撕\uf4b5秀\uf4b6绵\uf4b7简\uf4b8穆\uf4b9羽\uf4ba禀\uf4bb居\uf4bc缉\uf4bd固\uf4bf瞎\uf4c1梢\uf4c2禹\uf4c4力\uf4c6房\uf4c7叹\uf4c9壁\uf4ca扶\uf4cb航\uf4cd褂\uf4ce礁\uf4d0照\uf4d1罚\uf4d5拄" +
    "\uf4d8圆\uf4d9角\uf4dc蜂\uf4dd耕\uf4de沾\uf4df潇\uf4e0翘\uf4e1蔗\uf4e4嫌\uf4e6部\uf4e7肆\uf4e8描\uf4ea悴\uf4ed等\uf4ef梗\uf4f1伟\uf4f6陋\uf4f9玷\uf4fb窟\uf4fc恐\uf4fd字\uf500拘\uf502汤\uf504卡\uf505劲\uf507考\uf508渺\uf509欣\uf50a锐\uf50c鲨\uf512丛\uf513抢\uf515炭\uf516嗡\uf51b遇\uf51c蕊\uf51e幢\uf51f实\uf521叮\uf523奠" +
    "\uf524沙\uf525拧\uf528好\uf529羔\uf52a恼\uf52b坐\uf52d躏\uf52f晌\uf530歇\uf532谆\uf533声\uf534咐\uf535黯\uf538迟\uf539茫\uf53a狠\uf53f究\uf541帐\uf542蝴\uf543绚\uf544密\uf545够\uf546氯\uf547溃\uf548熄\uf549谜\uf54b畔\uf54d宋\uf54f跃\uf552慨\uf554彻\uf556屈\uf558喜\uf55a遵\uf55e禁\uf560光\uf562伤\uf563羚\uf564抽\uf565斧" +
    "\uf56a昼\uf570蝶\uf571躯\uf572都\uf577艳\uf57b丢\uf57c促\uf57d编\uf57e肿\uf57f骨\uf580摘\uf583撮\uf584俯\uf587江\uf588纹\uf58a擒\uf58b屉\uf58c夷\uf58d昏\uf58f庙\uf590载\uf593温\uf594句\uf596眉\uf599辨\uf59f娄\uf5a3顷\uf5a6苟\uf5a7和\uf5a9圾\uf5aa矛\uf5ac蜈\uf5ae箭\uf5af辉\uf5b0苞\uf5b2享\uf5b3久\uf5b6表\uf5b7筋\uf5bb朋" +
    "\uf5be认\uf5c1授\uf5c2慢\uf5c3韵\uf5c4旭\uf5c7彭\uf5c8哮\uf5ca碗\uf5cd美\uf5cf券\uf5d0沮\uf5d2桐\uf5d5耗\uf5d8沐\uf5da酉\uf5db扮\uf5dd测\uf5de姿\uf5df荡\uf5e1习\uf5e2袭\uf5e3元\uf5e4瓤\uf5e7牺\uf5e9砰\uf5eb凳\uf5ee磷\uf5f0棱\uf5f1出\uf5f2植\uf5f3福\uf5f6眶\uf5fc之\uf5fd鸿\uf5fe止\uf5ff犬\uf602瓦\uf604渡\uf605颠\uf606障" +
    "\uf608巢\uf60b窘\uf60d唆\uf60e鹃\uf610污\uf615赡\uf617畅\uf618徒\uf619伸\uf61b吁\uf61d判\uf61e驻\uf620弦\uf623稀\uf624璃\uf627裹\uf628次\uf629猩\uf62d再\uf631澡\uf632胀\uf636挎\uf637夕\uf639赃\uf63a勘\uf63b啰\uf63c聘\uf63d眷\uf63f拗\uf640膛\uf643奔\uf644刀\uf646哇\uf648鹦\uf649侯\uf64b言\uf64c荆\uf64d棵\uf650蚁\uf654蟋" +
    "\uf655婉\uf656镰\uf657衬\uf659退\uf65a暗\uf65c酒\uf65d猫\uf65e妆\uf65f捎\uf660锻\uf662豺\uf664钙\uf665新\uf668酌\uf669护\uf66c枯\uf66d反\uf66e朽\uf66f破\uf671尊\uf677峦\uf67a递\uf67b莽\uf67d哩\uf67f浦\uf680拔\uf681才\uf685肯\uf687吞\uf68c枕\uf68d阵\uf68f拭\uf691限\uf692猾\uf693开\uf694廓\uf696郁\uf697抡\uf699探\uf69a眯" +
    "\uf69b纺\uf69e姻\uf6a0桥\uf6a1孙\uf6a2秸\uf6a3苇\uf6a4靡\uf6aa栖\uf6ab削\uf6ad贼\uf6b0蜜\uf6b1诗\uf6b5蓬\uf6b7常\uf6bb我\uf6bc鹤\uf6be块\uf6c2肮\uf6c3徊\uf6c4菇\uf6c5味\uf6c6榴\uf6c8誓\uf6ca馏\uf6cb曙\uf6cc戏\uf6cd带\uf6cf惫\uf6d0浇\uf6d3瑞\uf6d5怎\uf6d7必\uf6d9孟\uf6da任\uf6db旁\uf6dd裳\uf6e0樟\uf6e1躲\uf6e2僧\uf6e5哈" +
    "\uf6e8寿\uf6e9瑟\uf6ea葫\uf6eb辛\uf6ec仅\uf6f0助\uf6f1账\uf6f2冬\uf6f3弓\uf6f4砖\uf6f5邮\uf6f6否\uf6f7缸\uf6fc阿\uf6fd拌\uf6fe郊\uf6ff夜\uf701沼\uf703噩\uf706枪\uf70a殖\uf70b饱\uf70c猴\uf711础\uf715珊\uf716滨\uf71a嘹\uf71b弊\uf71c惯\uf71f砍\uf720泻\uf722谷\uf724呻\uf725苦\uf727脖\uf729抗\uf72a嘿\uf72b殊\uf72d阅\uf72e周" +
    "\uf72f瘸\uf733椅\uf734差\uf735庶\uf736鸡\uf738机\uf73d凡\uf73e宽\uf73f皆\uf740卫\uf741袁\uf746较\uf748哼\uf74a筛\uf74c裙\uf74f晕\uf751椒\uf753牢\uf754械\uf756济\uf757俏\uf758褥\uf759隆\uf75a悍\uf75b糖\uf75c揉\uf75d倘\uf75f骆\uf761洁\uf762返\uf763淡\uf764州\uf766彰\uf769率\uf76b比\uf76c舵\uf76d娃\uf76e篷\uf771涣\uf772段" +
    "\uf774围\uf775株\uf776控\uf777豫\uf778万\uf779屡\uf77a车\uf77b欲\uf77c捡\uf77d泣\uf77e酬\uf781泄\uf782删\uf783码\uf786絮\uf787嫉\uf789茸\uf78f嘲\uf791鞋\uf792汹\uf796粉\uf798裁\uf799洽\uf79a轧\uf79d敌\uf79e妒\uf7a0寅\uf7a1保\uf7a4愣\uf7a5笑\uf7a7变\uf7a9疯\uf7ab腋\uf7ad抑\uf7ae臂\uf7b2伐\uf7b3母\uf7b7归\uf7ba疟\uf7bb诬" +
    "\uf7bc提\uf7bd理\uf7be鳖\uf7c1耘\uf7c4榜\uf7c5舆\uf7c7崔\uf7c8甥\uf7ca瓣\uf7cb悦\uf7cc致\uf7cd孕\uf7cf役\uf7d0哭\uf7d2笋\uf7d4摧\uf7d5愿\uf7d6橡\uf7d7楼\uf7d8缴\uf7dc吵\uf7dd逮\uf7df年\uf7e0尿\uf7e4蒸\uf7e6咧\uf7e7紧\uf7ea疲\uf7eb死\uf7ed袍\uf7ef害\uf7f0壳\uf7f1谢\uf7f2溜\uf7f4钉\uf7f6懦\uf7f7蘑\uf7f8劫\uf7fa蚀\uf7fd危" +
    "\uf7fe猖\uf800饮\uf801趁\uf805亿\uf808坤\uf809冀\uf80c曰\uf80e展\uf80f偷\uf811酿\uf813饭\uf81a顿\uf81b妃\uf81d辫\uf81e谱\uf820捆\uf821喻\uf822兰\uf824储\uf825砚\uf826骚\uf82a措\uf82b览\uf82d韩\uf82e准\uf82f捧\uf832搬\uf836胃\uf838凛\uf83a薄\uf83c钮\uf840景\uf842挤\uf846捍\uf848聚\uf84a蛀\uf84b逗\uf84d翩\uf84e贫\uf850恋" +
    "\uf851勺\uf852低\uf854潘\uf857么\uf85b询\uf85c速\uf85d吗\uf85e爆\uf860定\uf861醇\uf864趋\uf867座\uf868魂\uf86c露\uf86e恳\uf872鹊\uf875外\uf878观\uf879袄\uf87a熔\uf87d窃\uf87e哉\uf87f鲁\uf883正\uf885盟\uf886枢\uf888屯\uf889经\uf88a蹄\uf88c服\uf88d譬\uf88e诉\uf88f绊\uf893胁\uf894斟\uf896翁\uf897庵\uf898砾\uf899陕\uf89a雄" +
    "\uf89b献\uf89d漆\uf89e凰\uf89f羞\uf8a0败\uf8a2跟\uf8a3劳\uf8a4研\uf8a7仗\uf8a8篡\uf8aa甚\uf8ab摆\uf8ac濒\uf8ad蔬\uf8af孵\uf8b2查\uf8b3满\uf8b4钦\uf8b7领\uf8b8技\uf8b9砌\uf8bb犯\uf8bd农\uf8be卷\uf8bf业\uf8c2刺\uf8c3博\uf8c4戌\uf8c6绸\uf8c7良\uf8c8稽\uf8cb澎\uf8cc散\uf8cf掘\uf8d1作\uf8d3但\uf8d4尚\uf8d8染\uf8db羊\uf8dc弗" +
    "\uf8de玻\uf8e4绢\uf8e5撵\uf8e6昂\uf8e7该\uf8ea舀\uf8ec腔\uf8ed谅\uf8ee怒\uf8f0哨\uf8f3琐\uf8f4匠\uf8f5熟\uf8f6静\uf8f7宜\uf8f8飘\uf8f9彬\uf8fa只\uf8fc霍\uf8fe户";

  const BUILTIN_PUA_DICT = (() => {
    const dict = {};
    for (let i = 0; i + 1 < BUILTIN_PUA_DICT_PAIRS.length; i += 2) {
      dict[BUILTIN_PUA_DICT_PAIRS[i]] = BUILTIN_PUA_DICT_PAIRS[i + 1];
    }
    return dict;
  })();

  /**
   * 字形轮廓特征 Hash -> 汉字 映射表 (用于 TTF 字体打乱码位时动态重建映射)
   * 格式: { "a1b2c3d4": "的", ... }
   */
  const BUILTIN_GLYPH_HASH_MAP = {};

  /**
   * 取文轮询节拍器
   *
   * 标签页切到后台后 Chrome 会把 setTimeout 降频（隐藏久了甚至 1 分钟一次），表现为
   * 「iframe 早已还原完、脚本还在等」。Worker 里的定时器不受该降频影响，所以用 Worker 发节拍，
   * 主线程收到消息后再检查 iframe DOM；Worker/Blob 被 CSP 拦下时退回普通 setInterval。
   */
  const TextTicker = {
    worker: null,
    subs: new Set(),
    ensure() {
      if (this.worker) return true;
      try {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
          return false;
        }
        const url = URL.createObjectURL(
          new Blob(['setInterval(function(){postMessage(0)},120);'], { type: 'text/javascript' })
        );
        const worker = new Worker(url);
        worker.onmessage = () => {
          for (const fn of Array.from(this.subs)) {
            try {
              fn();
            } catch (e) {
              /* 单个订阅者异常不影响其它轮询 */
            }
          }
        };
        this.worker = worker;
        return true;
      } catch (e) {
        this.worker = null;
        return false;
      }
    },
    subscribe(fn) {
      if (!this.ensure()) {
        const timer = setInterval(fn, 300);
        return () => clearInterval(timer);
      }
      this.subs.add(fn);
      return () => {
        this.subs.delete(fn);
        if (this.subs.size === 0) this.dispose();
      };
    },
    dispose() {
      if (!this.worker) return;
      try {
        this.worker.terminate();
      } catch (e) {
        /* ignore */
      }
      this.worker = null;
    },
    sleep(ms) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        let done = false;
        let unsub = () => {};
        const finish = () => {
          if (done) return;
          done = true;
          unsub();
          resolve();
        };
        unsub = this.subscribe(() => {
          if (Date.now() - startedAt >= ms) finish();
        });
        if (!this.worker) setTimeout(finish, ms + 50);
      });
    },
  };

  /********************************************************************
   * 1. 基础工具函数 (延时、HTTP 请求、XML 转义、并发池)
   ********************************************************************/
  const Utils = {
    sleep(min = CONFIG.TEXT_DELAY_MIN, max = CONFIG.TEXT_DELAY_MAX) {
      const ms = Math.floor(Math.random() * (max - min + 1)) + min;
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    escapeXml(unsafe) {
      if (!unsafe) return '';
      return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    },

    sanitizeFilename(name) {
      return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    },

    /**
     * 读取元素文本时剔除本脚本注入的按钮节点
     * （按钮挂在分卷标题栏内，直接读 textContent 会把 "EPUB下载/抓取中..." 混进卷名）
     */
    textWithoutButton(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.linovelib-epub-btn').forEach((node) => node.remove());
      return clone.textContent.trim();
    },

    /**
     * 分卷标题归一化：去空白/全角空格/包裹书名号，便于详情页与目录页标题互相匹配
     */
    normalizeTitle(title) {
      if (!title) return '';
      return String(title)
        .replace(/[\s\u3000]+/g, '')
        .replace(/^[《「『]+|[》」』]+$/g, '');
    },

    /** 当前书名（详情页 og 标签或 h1） */
    currentBookTitle() {
      const meta = document.querySelector('meta[property="og:novel:book_name"]');
      if (meta && meta.content) return String(meta.content).trim();
      const h1 = document.querySelector('h1.book-name, .book-name, h1');
      return h1 ? this.textWithoutButton(h1) : '';
    },

    /** 收集 root 下属于本书的章节链接（含 cid(0) 占位） */
    chapterLinksIn(root, bookId) {
      if (!root || !root.querySelectorAll) return [];
      const re = bookId ? new RegExp(`/novel/${bookId}/\\d+`) : /\/novel\/\d+\/\d+/;
      return Array.from(root.querySelectorAll('a[href]')).filter((a) => {
        const href = a.getAttribute('href') || '';
        return re.test(href) || /cid\(0\)/.test(href);
      });
    },

    isHeaderLike(el) {
      if (!el || el.nodeType !== 1) return false;
      if (/^(H1|H2|H3|H4|H5|H6)$/.test(el.tagName)) return true;
      const cls = typeof el.className === 'string' ? el.className : '';
      return /(^|\s)(v-line|chapter-bar|volume-title|volume-name|vol-title|section_title)(\s|$)/.test(cls);
    },

    /** 在节点本身或其子树里找最靠后的一个"标题样"元素 */
    headerIn(node) {
      if (!node || node.nodeType !== 1) return null;
      if (this.isHeaderLike(node)) return node;
      if (!node.querySelectorAll) return null;
      const hs = Array.from(
        node.querySelectorAll(
          'h1, h2, h3, h4, .v-line, .chapter-bar, .volume-title, .volume-name, .section_title'
        )
      );
      return hs.length ? hs[hs.length - 1] : null;
    },

    /**
     * 从章节链接向上回溯，找到该链接所属分卷的标题
     * 跳过"本身已含章节链接"的前置兄弟（那是上一卷的容器，不是本卷标题）
     */
    headerForLink(link, bookId) {
      let node = link;
      let depth = 0;
      while (node && node !== document.body && depth < 8) {
        let sib = node.previousElementSibling;
        while (sib) {
          const header = this.headerIn(sib);
          const sibHasChapters = this.chapterLinksIn(sib, bookId).length > 0;
          if (header && !sibHasChapters && this.textWithoutButton(header)) return header;
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
        depth++;
      }
      return null;
    },

    /** 一组章节链接去重后的分卷标题（文档顺序） */
    headersForLinks(links, bookId) {
      const seen = new Set();
      const found = [];
      for (const link of links) {
        const header = this.headerForLink(link, bookId);
        if (header && !seen.has(header)) {
          seen.add(header);
          found.push(header);
        }
      }
      return found;
    },

    /** 求一组节点的最深公共祖先 */
    commonAncestor(nodes) {
      if (!nodes || nodes.length === 0) return null;
      let el = nodes[0].parentElement;
      while (el && !nodes.every((n) => el.contains(n))) el = el.parentElement;
      return el;
    },

    /** 文本是否像分卷标题：第 X 卷 / Vol.7 / 书名 + 号码 / 番外 … */
    looksLikeVolumeTitle(text, bookTitle = '') {
      const t = this.normalizeTitle(text);
      if (!t || t.length > 40) return false;

      const bt = this.normalizeTitle(bookTitle);
      if (bt && t.length > bt.length && t.startsWith(bt)) return true;

      return /第\s*[0-9一二三四五六七八九十百零〇两]+\s*[卷章篇部集]|^[Vv]ol(ume)?\.?\s*\d|番外|外传|特别篇|短篇集|上卷|下卷/.test(t);
    },

    /** 从标题解析卷号：优先阿拉伯数字，其次中文数字（第七卷 → 7） */
    parseVolumeNumber(text) {
      const t = this.normalizeTitle(text);
      if (!t) return null;
      const m = t.match(/(\d+)(?!.*\d)/);
      if (m) return Number(m[1]);
      const cn = t.match(/第\s*([一二三四五六七八九十百零〇两]+)\s*[卷章篇部集]/);
      if (cn) return this.chineseToNumber(cn[1]);
      return null;
    },

    chineseToNumber(s) {
      const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
      if (!s) return null;
      let total = 0;
      let section = 0;
      for (const ch of s) {
        if (ch === '百') {
          total += (section || 1) * 100;
          section = 0;
        } else if (ch === '十') {
          total += (section || 1) * 10;
          section = 0;
        } else if (ch in map) {
          section = map[ch];
        } else {
          return null;
        }
      }
      return total + section;
    },

    resolveUrl(href, base = location.origin) {
      if (!href || href.startsWith('javascript:')) return null;
      try {
        return new URL(href, base).href;
      } catch {
        return null;
      }
    },

    /**
     * 使用 GM_xmlhttpRequest 获取文本或二进制数据，支持自定义 Referer
     */
    request(url, { responseType = 'text', referer = location.href, timeout = 15000, withReferer = true } = {}) {
      return new Promise((resolve, reject) => {
        const headers = {
          Accept:
            responseType === 'text'
              ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
              : '*/*',
        };
        // 部分 Tampermonkey/Chromium 版本会丢弃自定义 Referer，允许调用方在 403 时退回无 Referer 重试
        if (withReferer && referer) headers.Referer = referer;

        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType,
          timeout,
          headers,
          onload(res) {
            if (res.status >= 200 && res.status < 300) {
              resolve(res);
            } else {
              if (res.status === 429 || res.status === 503) SPEED.penalize(`HTTP ${res.status}`);
              reject(new Error(`HTTP ${res.status}: ${url}`));
            }
          },
          onerror(err) {
            reject(new Error(`Network error: ${url} (${err.error || 'unknown'})`));
          },
          ontimeout() {
            reject(new Error(`Timeout (${timeout}ms): ${url}`));
          },
        });
      });
    },

    async fetchDoc(url, referer = location.href) {
      const res = await this.request(url, { responseType: 'text', referer });
      const parser = new DOMParser();
      return {
        doc: parser.parseFromString(res.responseText, 'text/html'),
        rawHtml: res.responseText,
        finalUrl: res.finalUrl || url,
      };
    },

    /**
     * 摘掉站点塞进正文的「诱饵段落」
     *
     * 站点还原段落顺序时会额外插入 20 个与原文完全相同的副本，再用动态插入的样式
     * `#TextContent p[data-kXXXX] { position:absolute; transform:scale(0) }` 把它们藏起来。
     * 这里不依赖布局（后台标签页的 getBoundingClientRect 可能全是 0），而是解析 CSSOM
     * 找出被隐藏的属性名，再按属性删除对应段落；最后用内联样式/计算样式兜底。
     *
     * @returns {number} 删除的段落数
     */
    stripDecoyParagraphs(doc) {
      if (!doc || !doc.querySelectorAll) return 0;
      const hiddenAttrs = new Set();

      try {
        const sheets = Array.from(doc.styleSheets || []);
        for (const sheet of sheets) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch (e) {
            continue; // 跨域样式表不可读，跳过
          }
          for (const rule of Array.from(rules || [])) {
            const text = rule.cssText || '';
            if (!/scale\(\s*0(?:\.0+)?\s*\)|display\s*:\s*none/i.test(text)) continue;
            const re = /\[([a-zA-Z0-9_-]+)\]/g;
            let m;
            while ((m = re.exec(text))) hiddenAttrs.add(m[1]);
          }
        }
      } catch (e) {
        /* ignore */
      }

      let removed = 0;
      const nodes = Array.from(doc.querySelectorAll('#TextContent p, #acontent p, .read-content p'));
      for (const p of nodes) {
        let hidden = false;
        for (const attr of hiddenAttrs) {
          if (p.hasAttribute(attr)) {
            hidden = true;
            break;
          }
        }
        if (!hidden) {
          const style = p.getAttribute('style') || '';
          if (/display\s*:\s*none|visibility\s*:\s*hidden|scale\(\s*0|font-size\s*:\s*0/i.test(style)) {
            hidden = true;
          } else {
            try {
              const view = doc.defaultView;
              const cs = view && view.getComputedStyle ? view.getComputedStyle(p) : null;
              const zeroTransform = /^matrix\(0(?:,\s*0){5}\)$/.test((cs && cs.transform || '').trim());
              if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || (zeroTransform && cs.position === 'absolute'))) {
                hidden = true;
              }
            } catch (e) {
              /* ignore */
            }
          }
        }
        if (hidden) {
          p.remove();
          removed += 1;
        }
      }
      return removed;
    },

    /** 正文里是否出现完全相同的段落（站点还原段落顺序后会插入 20 个诱饵副本） */
    hasDuplicateParagraphs(doc) {
      if (!doc || !doc.querySelectorAll) return false;
      const seen = new Set();
      for (const p of Array.from(doc.querySelectorAll('#TextContent p, #acontent p, .read-content p'))) {
        const text = (p.textContent || '').trim();
        if (!text) continue;
        if (seen.has(text)) return true;
        seen.add(text);
      }
      return false;
    },

    /**
     * 用「隐藏 iframe」取文：让真实页面在 iframe 里跑脚本，等它把乱序正文还原后再读 DOM
     *
     * 站点机制（v1.6.0 实测）：
     *   1. 服务端先下发**乱序**正文（前 20 段正确，其余为固定置换）；
     *   2. 约 2.5s 后页面脚本原地还原段落顺序，并额外插入 20 个与原文完全相同的「诱饵段落」；
     *   3. 再用动态插入的 `p[data-k…] { position:absolute; transform:scale(0) }` 把诱饵藏起来。
     * 因此：XHR 永远拿到乱序版（脚本不执行）；iframe 里脚本会执行，但必须等还原完成再读，
     * 读之前还要按 CSSOM 隐藏规则删掉诱饵。v1.5.0 的 iframe 方案失败，就是因为 load 后
     * 只等了 400ms，读到的仍是还原前的乱序版。
     *
     * 返回 null 表示不可用（被 X-Frame-Options 拦截、超时、加载失败），调用方回退 XHR。
     */
    async fetchViaFrame(url, options = {}) {
      const timeout = options.timeout || CONFIG.TEXT_FRAME_TIMEOUT;
      if (typeof document === 'undefined' || !document.body) return null;

      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.style.cssText =
        'position:fixed;left:-9999px;top:0;width:900px;height:700px;opacity:0;pointer-events:none;border:0;';
      document.body.appendChild(frame);

      const startedAt = Date.now();
      let targetPath = '';
      try {
        targetPath = new URL(url, location.href).pathname;
      } catch (e) {
        targetPath = '';
      }
      try {
        // 1. 轮询等真正的目标文档：appending iframe 会先触发一次 about:blank 的 load，不能只听 load
        const readyDoc = await new Promise((resolve) => {
          let done = false;
          let unsub = () => {};
          const finish = (value) => {
            if (done) return;
            done = true;
            unsub();
            resolve(value);
          };
          const tick = () => {
            if (Date.now() - startedAt > timeout) return finish(null);
            let d = null;
            try {
              d = frame.contentDocument;
            } catch (e) {
              d = null;
            }
            let onTarget = true;
            if (d && targetPath) {
              try {
                onTarget = new URL(d.URL).pathname === targetPath;
              } catch (e) {
                onTarget = false;
              }
            }
            if (
              d &&
              onTarget &&
              d.readyState !== 'loading' &&
              d.querySelector('#TextContent, #acontent, .read-content')
            ) {
              return finish(d);
            }
          };
          unsub = TextTicker.subscribe(tick);
          frame.src = url;
          tick();
        });
        if (!readyDoc) return null;
        const doc = readyDoc;

        // 2. 等站点脚本把乱序正文还原：还原后段落数会 +20（诱饵），或出现完全相同的段落
        const countParagraphs = () => doc.querySelectorAll('#TextContent p').length;
        const initialCount = countParagraphs();
        let unscrambled = initialCount <= 20 || Utils.hasDuplicateParagraphs(doc);
        if (!unscrambled) {
          const waitUntil = Date.now() + CONFIG.TEXT_UNSCRAMBLE_WAIT;
          while (Date.now() < waitUntil) {
            await TextTicker.sleep(CONFIG.TEXT_UNSCRAMBLE_POLL);
            if (!frame.contentDocument) return null;
            if (countParagraphs() > initialCount || Utils.hasDuplicateParagraphs(doc)) {
              unscrambled = true;
              break;
            }
          }
        }
        if (!unscrambled) {
          console.warn(
            '[EPUB Downloader] iframe 内未观察到段落还原（站点可能改版），本页顺序可能仍是乱序:',
            url
          );
        }

        // 3. 删除诱饵段落后序列化
        const removed = Utils.stripDecoyParagraphs(doc);
        let html = '';
        try {
          html = doc.documentElement.outerHTML;
        } catch (e) {
          return null;
        }
        if (!html) return null;
        return {
          doc: new DOMParser().parseFromString(html, 'text/html'),
          rawHtml: html,
          finalUrl: url,
          removedDecoys: removed,
          unscrambled,
        };
      } catch (e) {
        return null;
      } finally {
        try {
          frame.remove();
        } catch (e) {
          /* ignore */
        }
      }
    },

    /**
     * 固定并发队列执行器
     */
    async runConcurrent(items, concurrency, taskFn) {
      const results = new Array(items.length);
      let index = 0;
      const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (index < items.length) {
          const currentIndex = index++;
          results[currentIndex] = await taskFn(items[currentIndex], currentIndex);
        }
      });
      await Promise.all(workers);
      return results;
    },
  };

  /********************************************************************
   * 2. TTF 字体二进制解析与解密引擎 (FontDecryptor - 对应边界 4 & 8A)
   ********************************************************************/
  class FontDecryptor {
    constructor() {
      this.staticMap = {
        ...BUILTIN_STATIC_PUA_MAP,          // 高频种子（会被完整字典覆盖）
        ...BUILTIN_PUA_DICT,                // 站点完整 PUA 字典（3500 条）
        ...(GM_getValue('custom_static_pua_map', {}) || {}), // 用户导入优先
      };
      this.glyphHashMap = {
        ...BUILTIN_GLYPH_HASH_MAP,
        ...(GM_getValue('custom_glyph_hash_map', {}) || {}),
      };
      this.dynamicMap = GM_getValue('cached_dynamic_pua_map', {}) || {};
      this.cachedFontUrl = GM_getValue('cached_font_url', '');
      this.parsedFontUrls = new Set(); // 本次会话已尝试解析的字体，避免每页重复下载
      this.warnedKeys = new Set();
    }

    /**
     * 计算字节序列的 32-bit FNV-1a Hash
     */
    fnv1aHash(bytes) {
      let hash = 0x811c9dc5;
      for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }

    warnOnce(key, ...args) {
      if (this.warnedKeys.has(key)) return;
      this.warnedKeys.add(key);
      console.warn(...args);
    }

    /**
     * 检测页面是否启用了 readfont 加密，若是则尝试拉取 .ttf 更新映射表
     *
     * 实现注记（对应审核 P0-1）：站点目前可能只下发 .woff2（Brotli 压缩 + glyf 重建），
     * DataView 无法直接解析，因此这里显式判定并告警，而不是静默跳过；
     * 同时不再做"用内置静态表反推轮廓 Hash"的自动校准（对应 P0-2），
     * 避免把猜测值写进持久缓存、产出"像汉字但内容全错"的正文。
     */
    async ensureFontLoaded(doc, rawHtml, pageUrl) {
      const contentEl = doc.querySelector('#TextContent, #acontent');
      const isEncrypted =
        (contentEl && contentEl.classList.contains('readfont')) ||
        /font-family\s*:\s*['"]?readfont/i.test(rawHtml);

      if (!isEncrypted) return false;

      const ttfMatch = rawHtml.match(/url\(['"]?([^'")]+?\.ttf[^'")]*)['"]?\)/i);
      const woff2Match = rawHtml.match(/url\(['"]?([^'")]+?\.woff2[^'")]*)['"]?\)/i);
      const fontHref = (ttfMatch && ttfMatch[1]) || (woff2Match && woff2Match[1]);

      if (!fontHref) {
        this.warnOnce(
          'no-font-face',
          '[EPUB Downloader] 检测到 readfont 加密，但页面内未找到 @font-face 字体链接，本次仅使用静态字典'
        );
        return true;
      }

      const fontUrl = Utils.resolveUrl(fontHref, pageUrl);
      if (!fontUrl) return true;

      // 仅 .ttf 可被原生解析；woff2 需 Brotli 解压与 glyf 重建，这里明确降级
      if (!/\.ttf(\?|#|$)/i.test(fontUrl)) {
        this.warnOnce(
          `woff2:${fontUrl}`,
          `[EPUB Downloader] 加密字体不是 TTF（${fontUrl}），无法用 DataView 解析 cmap/glyf，本次仅使用静态字典`
        );
        return true;
      }

      if (this.parsedFontUrls.has(fontUrl)) return true;
      if (fontUrl === this.cachedFontUrl && Object.keys(this.dynamicMap).length > 0) {
        this.parsedFontUrls.add(fontUrl);
        return true;
      }

      this.parsedFontUrls.add(fontUrl);
      try {
        const res = await Utils.request(fontUrl, {
          responseType: 'arraybuffer',
          referer: pageUrl,
        });
        const parsedInfo = this.parseTTF(res.response);
        const rebuiltMap = {};

        for (const [codePoint, glyphHash] of Object.entries(parsedInfo.codePointToHash)) {
          const char = String.fromCodePoint(Number(codePoint));
          if (this.glyphHashMap[glyphHash]) {
            rebuiltMap[char] = this.glyphHashMap[glyphHash];
          }
        }

        if (Object.keys(rebuiltMap).length > 0) {
          this.dynamicMap = rebuiltMap;
          this.cachedFontUrl = fontUrl;
          GM_setValue('cached_dynamic_pua_map', rebuiltMap);
          GM_setValue('cached_font_url', fontUrl);
          console.info(
            `[EPUB Downloader] 轮廓字典命中 ${Object.keys(rebuiltMap).length} 个字形，字体映射已刷新`
          );
        } else {
          this.warnOnce(
            `empty-dict:${fontUrl}`,
            '[EPUB Downloader] TTF 已解析，但轮廓字典（custom_glyph_hash_map）为空，无法重建映射；' +
              '正文将回退到静态 PUA 字典，请通过油猴菜单「导入轮廓 Hash 字典」补全'
          );
        }
      } catch (err) {
        this.warnOnce(`parse-fail:${fontUrl}`, '[EPUB Downloader] TTF 字体拉取或解析失败，回退至静态字典:', err);
      }
      return true;
    }

    /**
     * 统计文本中仍未还原的 PUA 字符数量，用于向用户暴露解密覆盖率
     */
    countUndecrypted(text) {
      if (!text) return 0;
      const hits = text.match(/[\uE000-\uF8FF]/g);
      return hits ? hits.length : 0;
    }

    /**
     * 原生二进制解析 TrueType (.ttf) 的 head / maxp / loca / glyf / cmap 表
     * 输出 { codePointToHash: { [unicodeInt]: "8位hex轮廓特征" } }
     */
    parseTTF(arrayBuffer) {
      const view = new DataView(arrayBuffer);
      const numTables = view.getUint16(4, false);
      const tables = {};

      for (let i = 0; i < numTables; i++) {
        const base = 12 + i * 16;
        const tag = String.fromCharCode(
          view.getUint8(base),
          view.getUint8(base + 1),
          view.getUint8(base + 2),
          view.getUint8(base + 3)
        );
        tables[tag] = {
          offset: view.getUint32(base + 8, false),
          length: view.getUint32(base + 12, false),
        };
      }

      if (!tables.head || !tables.maxp || !tables.loca || !tables.glyf || !tables.cmap) {
        throw new Error('TTF 缺少核心表 (head/maxp/loca/glyf/cmap)');
      }

      const indexToLocFormat = view.getInt16(tables.head.offset + 50, false);
      const numGlyphs = view.getUint16(tables.maxp.offset + 4, false);

      // 1. 读取 loca 表获取每个 glyph 在 glyf 中的偏移
      const locaOffsets = new Uint32Array(numGlyphs + 1);
      for (let i = 0; i <= numGlyphs; i++) {
        if (indexToLocFormat === 0) {
          locaOffsets[i] = view.getUint16(tables.loca.offset + i * 2, false) * 2;
        } else {
          locaOffsets[i] = view.getUint32(tables.loca.offset + i * 4, false);
        }
      }

      // 2. 提取指定 glyphIndex 的轮廓特征 Hash（剥离 TrueType hints 指令以保证跨编译稳定性）
      const getGlyphContourHash = (glyphId) => {
        if (glyphId < 0 || glyphId >= numGlyphs) return '00000000';
        const start = tables.glyf.offset + locaOffsets[glyphId];
        const end = tables.glyf.offset + locaOffsets[glyphId + 1];
        if (start >= end) return '00000000'; // 空白字形

        const numContours = view.getInt16(start, false);
        if (numContours > 0) {
          // 简单字形: Header(10 bytes) + endPtsOfContours(2 * numContours) + instructionLength(2) + instructions + flags/coords
          const instrLenOffset = start + 10 + numContours * 2;
          if (instrLenOffset + 2 <= end) {
            const instrLen = view.getUint16(instrLenOffset, false);
            const coordsOffset = instrLenOffset + 2 + instrLen;
            if (coordsOffset < end) {
              // 组合 Header + endPts + 纯净轮廓坐标流计算 Hash
              const headerAndEnds = new Uint8Array(arrayBuffer, start, 10 + numContours * 2);
              const flagsAndCoords = new Uint8Array(arrayBuffer, coordsOffset, end - coordsOffset);
              const combined = new Uint8Array(headerAndEnds.length + flagsAndCoords.length);
              combined.set(headerAndEnds, 0);
              combined.set(flagsAndCoords, headerAndEnds.length);
              return this.fnv1aHash(combined);
            }
          }
        }
        // 复合字形或兜底直接对字形字节流计算 Hash
        return this.fnv1aHash(new Uint8Array(arrayBuffer, start, end - start));
      };

      // 3. 解析 cmap 表 (支持 Format 4 与 Format 12)
      const cmapOffset = tables.cmap.offset;
      const numSubtables = view.getUint16(cmapOffset + 2, false);
      const codePointToGlyph = {};

      for (let i = 0; i < numSubtables; i++) {
        const subOffset = cmapOffset + view.getUint32(cmapOffset + 4 + i * 8 + 4, false);
        const format = view.getUint16(subOffset, false);

        if (format === 4) {
          const segCount = view.getUint16(subOffset + 6, false) / 2;
          const endCountBase = subOffset + 14;
          const startCountBase = endCountBase + segCount * 2 + 2;
          const idDeltaBase = startCountBase + segCount * 2;
          const idRangeOffsetBase = idDeltaBase + segCount * 2;

          for (let s = 0; s < segCount; s++) {
            const endCode = view.getUint16(endCountBase + s * 2, false);
            const startCode = view.getUint16(startCountBase + s * 2, false);
            const idDelta = view.getInt16(idDeltaBase + s * 2, false);
            const idRangeOffset = view.getUint16(idRangeOffsetBase + s * 2, false);

            // 规范终止段为 endCode === 0xFFFF（原实现误判 startCode）
            if (endCode === 0xffff) break;
            // 重点扫描 PUA 私有区 (0xE000 ~ 0xF8FF)
            const scanStart = Math.max(startCode, 0xe000);
            const scanEnd = Math.min(endCode, 0xf8ff);

            for (let cp = scanStart; cp <= scanEnd; cp++) {
              let glyphId = 0;
              if (idRangeOffset === 0) {
                glyphId = (cp + idDelta) & 0xffff;
              } else {
                const glyphOffset =
                  idRangeOffsetBase + s * 2 + idRangeOffset + (cp - startCode) * 2;
                glyphId = view.getUint16(glyphOffset, false);
                if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xffff;
              }
              if (glyphId !== 0) codePointToGlyph[cp] = glyphId;
            }
          }
        } else if (format === 12) {
          const numGroups = view.getUint32(subOffset + 12, false);
          for (let g = 0; g < numGroups; g++) {
            const groupBase = subOffset + 16 + g * 12;
            const startCode = view.getUint32(groupBase, false);
            const endCode = view.getUint32(groupBase + 4, false);
            const startGlyphId = view.getUint32(groupBase + 8, false);
            const scanStart = Math.max(startCode, 0xe000);
            const scanEnd = Math.min(endCode, 0xf8ff);
            for (let cp = scanStart; cp <= scanEnd; cp++) {
              codePointToGlyph[cp] = startGlyphId + (cp - startCode);
            }
          }
        }
      }

      const codePointToHash = {};
      for (const [cp, glyphId] of Object.entries(codePointToGlyph)) {
        codePointToHash[cp] = getGlyphContourHash(glyphId);
      }

      return { codePointToHash, codePointToGlyph };
    }

    /**
     * 解密单段文本：优先查动态轮廓映射表，其次查静态 PUA 映射表
     */
    decryptText(text) {
      if (!text) return '';
      let out = '';
      for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code >= 0xe000 && code <= 0xf8ff) {
          out += this.dynamicMap[ch] || this.staticMap[ch] || ch;
        } else {
          out += ch;
        }
      }
      return out;
    }
  }

  /********************************************************************
   * 3. 目录与分卷元数据解析器 (CatalogResolver - 对应边界 1, 2, 9A)
   ********************************************************************/
  class CatalogResolver {
    /**
     * 提取当前 URL 中的书籍 ID
     */
    static getBookId() {
      const m = location.pathname.match(/\/novel\/(\d+)/);
      return m ? m[1] : null;
    }

    /**
     * 统一获取某本书的完整分卷与章节结构
     * 返回: { bookId, bookTitle, author, bookCover, detailUrl, catalogUrl,
     *         volumes: [ { index, order, title, coverUrl, chapters: [ { title, url } ] } ] }
     *
     * index 为"有章节的分卷"的连续序号（0-based，与 §4.2 schema 一致，等价于数组下标）；
     * order 为分卷在目录页中的 DOM 序号，仅用于展示与标题兜底匹配。
     */
    static async resolveBookCatalog(bookId) {
      const detailUrl = `${location.origin}/novel/${bookId}.html`;
      const catalogUrl = `${location.origin}/novel/${bookId}/catalog`;

      const isDetailPage = /\/novel\/\d+\.html$/.test(location.pathname);
      const isCatalogPage = /\/novel\/\d+\/catalog/.test(location.pathname);

      const detailDoc = isDetailPage ? document : (await Utils.fetchDoc(detailUrl)).doc;
      const catalogDoc = isCatalogPage ? document : (await Utils.fetchDoc(catalogUrl)).doc;

      // 1. 提取书籍全局元数据
      const bookTitle =
        detailDoc.querySelector('meta[property="og:novel:book_name"]')?.content ||
        detailDoc.querySelector('.book-name, .book-title, h1')?.textContent?.trim() ||
        catalogDoc.querySelector('.book-meta h1, h1')?.textContent?.trim() ||
        `Novel_${bookId}`;

      const author =
        detailDoc.querySelector('meta[property="og:novel:author"]')?.content ||
        detailDoc.querySelector('.au-name a, .book-rand-a a')?.textContent?.trim() ||
        '未知作者';

      const bookCover = Utils.resolveUrl(
        detailDoc.querySelector('meta[property="og:image"]')?.content ||
          detailDoc.querySelector('.book-img img')?.getAttribute('src') ||
          ''
      ) || '';

      // 2. 从详情页提取分卷封面映射 (分卷名 -> 封面URL)
      const detailVolumeCovers = new Map();
      const detailVolumeCards = detailDoc.querySelectorAll(
        '.volume, .volume-info, .book-vol-list .vol-item, #volume-list .volume-info, .section_list li'
      );
      detailVolumeCards.forEach((card, idx) => {
        const vTitle = Utils.textWithoutButton(
          card.querySelector('h2.v-line, .v-line, .v-title, .vol-title, h2, h3, .section_title')
        );
        const imgEl = card.querySelector('img');
        const cover =
          imgEl?.getAttribute('data-src') ||
          imgEl?.getAttribute('src') ||
          bookCover;
        const resolvedCover = Utils.resolveUrl(cover);
        if (vTitle) detailVolumeCovers.set(Utils.normalizeTitle(vTitle), resolvedCover);
        detailVolumeCovers.set(`__idx_${idx}`, resolvedCover);
      });

      // 3. 从目录页提取分卷与章节列表
      //    优先使用站点实际模板 div.volume.clearfix（内含 h2.v-line + li.col-4），
      //    避免 .volume 与 .volume-info 同时命中导致分卷/章节重复计算。
      let volumeBlocks = Array.from(catalogDoc.querySelectorAll('.volume'));
      if (volumeBlocks.length === 0) {
        volumeBlocks = Array.from(catalogDoc.querySelectorAll('.volume-info'));
      }

      const volumes = [];
      const seenChapterKeys = new Set();

      const readChapters = (block) => {
        const chapters = [];
        block.querySelectorAll('li a, .chapter-li a, .chapter-list a').forEach((a) => {
          const rawHref = (a.getAttribute('href') || '').trim();
          const title = a.textContent.trim();
          if (!title) return;
          const url = rawHref.includes('cid(0)') ? null : Utils.resolveUrl(rawHref);
          const key = `${title}|${url || ''}`;
          if (seenChapterKeys.has(key)) return;
          seenChapterKeys.add(key);
          chapters.push({ title, url });
        });
        return chapters;
      };

      if (volumeBlocks.length > 0) {
        // 结构 A: 每个分卷包裹在独立的 .volume / .volume-info 容器中
        volumeBlocks.forEach((block, vIdx) => {
          const vTitle =
            Utils.textWithoutButton(
              block.querySelector('h2.v-line, .v-line, .v-title, .sub-tit, h2, h3')
            ) || `第 ${vIdx + 1} 卷`;
          const imgEl = block.querySelector('.v-cover img, img');
          const rawCover =
            imgEl?.getAttribute('data-src') ||
            imgEl?.getAttribute('src') ||
            detailVolumeCovers.get(Utils.normalizeTitle(vTitle)) ||
            detailVolumeCovers.get(`__idx_${volumes.length}`) ||
            bookCover;

          const chapters = readChapters(block);
          if (chapters.length > 0) {
            volumes.push({
              index: volumes.length, // 连续序号 = 数组下标，修复旧实现 index/下标错位
              order: vIdx,
              title: vTitle,
              coverUrl: Utils.resolveUrl(rawCover),
              chapters,
            });
          }
        });
      } else {
        // 结构 B: 扁平列表 (.chapter-bar / .v-line 作为分卷头，后续 li 为章节)
        const listItems = catalogDoc.querySelectorAll(
          '#volume-list > *, #volumes > *, .chapter-list > *'
        );
        let currentVol = null;

        listItems.forEach((el) => {
          const isHeader =
            el.classList.contains('chapter-bar') ||
            el.classList.contains('v-line') ||
            el.classList.contains('volume-bar') ||
            el.tagName === 'H2' ||
            el.tagName === 'H3';

          if (isHeader) {
            const vIdx = volumes.length;
            const vTitle = Utils.textWithoutButton(el) || `第 ${vIdx + 1} 卷`;
            currentVol = {
              index: vIdx,
              order: vIdx,
              title: vTitle,
              coverUrl:
                detailVolumeCovers.get(Utils.normalizeTitle(vTitle)) ||
                detailVolumeCovers.get(`__idx_${vIdx}`) ||
                Utils.resolveUrl(bookCover),
              chapters: [],
            };
            volumes.push(currentVol);
          } else {
            const links = el.matches('a') ? [el] : Array.from(el.querySelectorAll('a'));
            links.forEach((a) => {
              if (!currentVol) {
                currentVol = {
                  index: 0,
                  order: 0,
                  title: '正文',
                  coverUrl: Utils.resolveUrl(bookCover),
                  chapters: [],
                };
                volumes.push(currentVol);
              }
              const rawHref = (a.getAttribute('href') || '').trim();
              const title = a.textContent.trim();
              if (!title) return;
              const url = rawHref.includes('cid(0)') ? null : Utils.resolveUrl(rawHref);
              const key = `${title}|${url || ''}`;
              if (seenChapterKeys.has(key)) return;
              seenChapterKeys.add(key);
              currentVol.chapters.push({ title, url });
            });
          }
        });
      }

      // 结构 C：站点改版后既无 .volume/.volume-info 也无 #volume-list
      // 按"章节链接回溯最近标题"分组，兼容任意类名
      if (volumes.length === 0) {
        const links = Utils.chapterLinksIn(catalogDoc, bookId);
        const groups = [];
        const byHeader = new Map();
        const seen = new Set();

        for (const a of links) {
          const title = a.textContent.trim();
          if (!title) continue;
          const href = (a.getAttribute('href') || '').trim();
          const url = href.includes('cid(0)') ? null : Utils.resolveUrl(href);
          const key = `${title}|${url || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const header = Utils.headerForLink(a, bookId);
          let group = byHeader.get(header);
          if (!group) {
            group = { header, chapters: [] };
            byHeader.set(header, group);
            groups.push(group);
          }
          group.chapters.push({ title, url });
        }

        groups.forEach((group, i) => {
          if (group.chapters.length === 0) return;
          volumes.push({
            index: volumes.length,
            order: i,
            title: group.header ? Utils.textWithoutButton(group.header) : '正文',
            coverUrl: Utils.resolveUrl(bookCover),
            chapters: group.chapters,
          });
        });
      }

      return { bookId, bookTitle, author, bookCover, detailUrl, catalogUrl, volumes };
    }
  }

  /********************************************************************
   * 4. 章节抓取与双向链接修复引擎 (ChapterScraper - 对应边界 3A, 5A, 6A)
   ********************************************************************/
  class ChapterScraper {
    constructor(fontDecryptor) {
      this.fontDecryptor = fontDecryptor;
      this.textRequests = 0;
      // iframe 取文：站点在页面脚本里还原乱序段落，XHR 拿到的是未还原的乱序版
      this.frameFailures = 0;
      this.removedDecoys = 0;
      this.unscrambledPages = 0;
      this.checkedPages = 0;
    }

    /**
     * 取一页正文
     *
     * 优先用隐藏 iframe（脚本会执行、段落会被还原）；连续失败才回退 XHR 并告警顺序风险。
     */
    async fetchPage(url, referer = location.href) {
      if (CONFIG.TEXT_FRAME && this.frameFailures < 3) {
        const framed = await Utils.fetchViaFrame(url);
        if (framed && framed.doc.querySelector('#TextContent, #acontent, .read-content')) {
          this.frameFailures = 0;
          this.removedDecoys += framed.removedDecoys || 0;
          this.checkedPages += 1;
          if (framed.unscrambled) this.unscrambledPages += 1;
          return framed;
        }
        this.frameFailures += 1;
        console.warn(
          `[EPUB Downloader] iframe 取文失败 ${this.frameFailures}/3，本页回退 XHR（正文顺序可能错乱）:`,
          url
        );
      }
      return Utils.fetchDoc(url, referer);
    }

    /**
     * 从阅读页 HTML 中提取 ReadParams (url_previous, url_next)
     */
    extractNavUrls(doc, rawHtml, currentUrl) {
      // ReadParams 既可能是 { url_next: '...' } 也可能是 {"url_next":"..."}，键两侧引号可有可无
      let prevHref =
        rawHtml.match(/["']?url_previous["']?\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
        doc.querySelector('#footlink a:first-child, .mlfy_page a:first-child')?.getAttribute('href');

      let nextHref =
        rawHtml.match(/["']?url_next["']?\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
        doc.querySelector('#footlink a:last-child, .mlfy_page a:last-child')?.getAttribute('href');

      return {
        prevUrl: Utils.resolveUrl(prevHref, currentUrl),
        nextUrl: Utils.resolveUrl(nextHref, currentUrl),
      };
    }

    /**
     * 边界 3A: 若本卷起始若干章为 cid(0)，通过后续首个有效章节的 url_previous 反向推导回填
     */
    async repairLeadingMissingUrls(volume, allVolumes, onProgress) {
      const chapters = volume.chapters;
      if (chapters.length === 0 || chapters[0].url) return;

      // 寻找本卷第一个拥有有效 URL 的章节索引 k
      const firstValidIdx = chapters.findIndex((ch) => Boolean(ch.url));

      if (firstValidIdx > 0) {
        onProgress(`修复卷首缺失链接 (回溯中)...`);
        let cursorUrl = chapters[firstValidIdx].url;

        for (let idx = firstValidIdx - 1; idx >= 0; idx--) {
          await Pacer.waitText();
          const { doc, rawHtml, finalUrl } = await this.fetchPage(cursorUrl);
          const { prevUrl } = this.extractNavUrls(doc, rawHtml, finalUrl);
          if (!prevUrl || /\/catalog/.test(prevUrl)) break;

          // prevUrl 可能是上一章的最后一页 (如 12345_3.html)，剥离 _N 后缀即得上一章首页
          const prevFirstPageUrl = prevUrl.replace(/_\d+\.html$/, '.html');
          chapters[idx].url = prevFirstPageUrl;
          cursorUrl = prevFirstPageUrl;
        }
      } else if (volume.index > 0) {
        // 极端情况：本卷全部为 cid(0)，从上一卷末章顺藤摸瓜
        // volume.index 是"有章节分卷"的连续序号，等价于数组下标（旧实现混用 DOM 序号，会取错卷）
        const prevVol =
          allVolumes.find((v) => v.index === volume.index - 1) || allVolumes[volume.index - 1];
        const lastCh = prevVol?.chapters?.[prevVol.chapters.length - 1];
        if (lastCh?.url) {
          onProgress(`从上一卷末章推导首章链接...`);
          // 末页只能通过分页链到达；navOnly 模式跳过去噪/段落提取，仅沿 url_next 走完整章
          const res = await this.scrapeSingleChapter(lastCh, () => {}, { navOnly: true });
          if (res.nextChapterUrl) {
            chapters[0].url = res.nextChapterUrl;
          }
        }
      }
    }

    /**
     * 判断 nextUrl 是否属于本章的后续分页（容忍查询串/锚点，旧实现遇到 ?x=1 会误判为下一章）
     */
    isSameChapterPage(nextUrl, chapterId) {
      if (!nextUrl || !chapterId) return false;
      return new RegExp(`/${chapterId}_\\d+\\.html(?:[?#].*)?$`).test(nextUrl);
    }

    /**
     * 按 DOM 顺序把正文拆成"文本 / 插图"段落流
     *
     * 旧实现只遍历 contentEl 的直接元素子节点，会丢掉裸文本节点，
     * 且在正文被单层 <div> 包裹时把整章合并成一段。这里改为递归下行，
     * 以 <p>/<br>/块级元素作为段落边界，保持图文原始顺序。
     */
    extractParagraphs(contentEl, pageUrl, isEncrypted, paragraphs, imageUrls) {
      const BLOCK_TAGS = new Set([
        'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR',
      ]);
      let buffer = [];

      const flush = () => {
        const raw = buffer.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
        buffer = [];
        if (!raw) return;
        const text = isEncrypted ? this.fontDecryptor.decryptText(raw) : raw;
        // 过滤防盗水印行
        if (/linovelib\.com|bilinovel\.com|哔哩轻小说/i.test(text)) return;
        paragraphs.push({ type: 'text', text });
      };

      const pushImage = (img) => {
        const rawSrc =
          img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('src');
        const fullImgUrl = Utils.resolveUrl(rawSrc, pageUrl);
        if (!fullImgUrl) return;
        const referer = pageUrl;
        imageUrls.push({ url: fullImgUrl, referer });
        paragraphs.push({ type: 'image', url: fullImgUrl });
      };

      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          buffer.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = node;
        const tag = el.tagName;

        if (tag === 'BR') {
          flush();
          return;
        }
        if (tag === 'IMG') {
          flush();
          pushImage(el);
          return;
        }
        // 隐藏节点（含 style 隐藏）已在上层移除，这里再兜一层
        if (el.getAttribute && /display\s*:\s*none|font-size\s*:\s*0/i.test(el.getAttribute('style') || '')) {
          return;
        }

        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) flush();
        for (const child of Array.from(el.childNodes)) walk(child);
        if (isBlock) flush();
      };

      for (const child of Array.from(contentEl.childNodes)) walk(child);
      flush();
    }

    /**
     * 抓取单个章节的所有分页 (串行 800~1500ms 延时)，合并正文并提取插图列表
     * @param {{navOnly?: boolean}} options navOnly 时只沿分页链取 nextChapterUrl，不解析正文
     */
    async scrapeSingleChapter(chapter, onPageProgress, { navOnly = false } = {}) {
      if (!chapter.url) {
        throw new Error(`章节《${chapter.title}》缺少有效链接且无法自动推导`);
      }

      // 容忍 _N 分页后缀与查询串，避免 chapterId 解析失败导致只抓首页
      const chapterIdMatch = chapter.url.match(/\/(\d+)(?:_\d+)?\.html(?:[?#].*)?$/);
      const chapterId = chapterIdMatch ? chapterIdMatch[1] : null;

      let pageUrl = chapter.url;
      let pageNum = 1;
      let nextChapterUrl = null;
      const htmlParagraphs = [];
      const imageUrls = [];

      while (pageUrl) {
        onPageProgress(pageNum);
        await Pacer.waitText();

        this.textRequests += 1;
        const { doc, rawHtml, finalUrl } = await this.fetchPage(pageUrl);
        const isEncrypted = await this.fontDecryptor.ensureFontLoaded(doc, rawHtml, finalUrl);

        if (!navOnly) {
          // 定位正文容器并净化干扰节点
          const contentEl = doc.querySelector('#TextContent, #acontent, .read-content');
          if (contentEl) {
            contentEl
              .querySelectorAll(
                'script, style, ins, iframe, .tp, .bd, .google-auto-placed, #show-more-images, #hidden-images, .dag, [style*="display:none"], [style*="font-size:0"]'
              )
              .forEach((el) => el.remove());

            this.extractParagraphs(contentEl, finalUrl, isEncrypted, htmlParagraphs, imageUrls);
          }
        }

        // 解析下一页 / 下一章链接
        const { nextUrl } = this.extractNavUrls(doc, rawHtml, finalUrl);
        if (!nextUrl) break;

        if (this.isSameChapterPage(nextUrl, chapterId)) {
          pageUrl = nextUrl;
          pageNum++;
        } else {
          // 如果指向另一章的首页 (如 /novel/2771/99999.html)，保存供下一章 cid(0) 修复
          if (/\/(\d+)(?:_\d+)?\.html(?:[?#].*)?$/.test(nextUrl)) {
            nextChapterUrl = nextUrl;
          }
          break;
        }
      }

      return {
        title: chapter.title,
        paragraphs: htmlParagraphs,
        imageUrls,
        nextChapterUrl,
      };
    }

    /**
     * 边界 5A: 带 Referer 与重试的单图下载，失败返回 null 触发降级
     * 重试语义对齐决策 5：首发 1 次 + 重试 IMG_MAX_RETRIES(3) 次 = 共 4 次尝试；
     * 若连续收到 401/403（防盗链），最后一次改为不带 Referer 再试一次。
     */
    async downloadImageWithRetry(imgUrl, referer, options = {}) {
      const timeoutMs = options.timeoutMs || CONFIG.IMG_TIMEOUT;
      const maxAttempts = 1 + (options.maxRetries != null ? options.maxRetries : CONFIG.IMG_MAX_RETRIES);
      let lastError = null;

      const attemptOnce = async (withReferer) => {
        const res = await Utils.request(imgUrl, {
          responseType: 'arraybuffer',
          referer,
          withReferer,
          timeout: timeoutMs,
        });
        if (!res.response || res.response.byteLength <= 100) {
          throw new Error(`响应体过小 (${res.response ? res.response.byteLength : 0} bytes)`);
        }
        const extMatch = imgUrl.match(/\.(jpe?g|png|gif|webp)([?#]|$)/i);
        const ext = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
        const mimeMap = {
          jpg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
        };
        return {
          buffer: res.response,
          ext,
          mime: mimeMap[ext] || 'image/jpeg',
        };
      };

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await attemptOnce(true);
        } catch (err) {
          lastError = err;
        }

        const errText = String((lastError && lastError.message) || '');
        // 404 属永久失败，重试没有意义
        if (/HTTP 404/.test(errText)) break;

        // 防盗链判定：TM 部分版本会丢弃 Referer 头，此时退回无 Referer 尝试
        if (attempt === maxAttempts - 1 && /HTTP 40[13]/.test(errText)) {
          try {
            return await attemptOnce(false);
          } catch (err) {
            lastError = err;
          }
        }

        console.warn(
          `[EPUB Downloader] 插图下载失败 (${attempt}/${maxAttempts}): ${imgUrl} -> ${lastError && lastError.message}`
        );
        if (attempt < maxAttempts) {
          const backoff = CONFIG.IMG_RETRY_BACKOFF * attempt;
          await Utils.sleep(backoff, backoff + 400);
        }
      }
      console.warn(`[EPUB Downloader] 插图重试耗尽，降级为 [插图加载失败]: ${imgUrl}`);
      return null;
    }

    /**
     * 抓取完整分卷 (章节串行 + 章节内图片 3 并发)
     *
     * 局部失败（单章 404、链接无法推导）不再中断整卷：生成占位章节继续打包，
     * 与原则 3「绝不因局部资源异常中断整卷 EPUB 的打包流程」对齐。
     */
    async scrapeVolume(volume, allVolumes, updateStatus, bookMeta = {}) {
      const startedAt = Date.now();
      this.textRequests = 0;
      this.frameFailures = 0;
      this.removedDecoys = 0;
      this.unscrambledPages = 0;
      this.checkedPages = 0;

      console.info('[EPUB Downloader] 取文通道', {
        mode: CONFIG.TEXT_FRAME ? 'frame' : 'xhr',
        note: CONFIG.TEXT_FRAME
          ? '隐藏 iframe 执行站点脚本，等待段落还原后读取'
          : '已关闭 iframe 取文，XHR 拿到的是乱序正文',
      });

      // 1. 先检查并修复卷首可能的 cid(0)
      await this.repairLeadingMissingUrls(volume, allVolumes, updateStatus);

      const scrapedChapters = [];
      const imageRegistry = new Map(); // imageUrl -> { id, filename, mime, buffer } | null
      const pendingImages = new Set();
      const imageJobs = [];
      let imgCounter = 1;
      let failedChapters = 0;
      let undecryptedChars = 0;
      let totalImages = 0;
      let completedImages = 0;

      // 封面先入池：与正文抓取并行，不再等正文跑完才下封面
      const coverUrl = volume.coverUrl || bookMeta.bookCover || null;
      const coverReferer = bookMeta.detailUrl || location.href;
      let coverData = null;
      let staleImages = false; // 宽限期结束后，迟到的图片直接丢弃，避免污染构建与按钮文案

      if (coverUrl) {
        totalImages += 1;
        imageJobs.push(
          ImagePool.add(async () => {
            // 封面单独用短超时 + 1 次重试，图床挂住时不再拖住整卷
            // 封面属于可选项：单次 6s、不重试，失败立刻换书籍封面，绝不拖住整卷
            let rawCover = await this.downloadImageWithRetry(coverUrl, coverReferer, {
              timeoutMs: CONFIG.COVER_TIMEOUT,
              maxRetries: 0,
            });
            if (!rawCover && bookMeta.bookCover && bookMeta.bookCover !== coverUrl) {
              rawCover = await this.downloadImageWithRetry(bookMeta.bookCover, coverReferer, {
                timeoutMs: CONFIG.COVER_TIMEOUT,
                maxRetries: 0,
              });
            }
            if (staleImages) return;
            if (rawCover) {
              coverData = {
                id: 'cover-image',
                filename: `cover.${rawCover.ext}`,
                mime: rawCover.mime,
                buffer: rawCover.buffer,
              };
            }
            completedImages += 1;
            updateStatus(`下载图片: ${completedImages}/${totalImages}...`);
          })
        );
      }

      for (let i = 0; i < volume.chapters.length; i++) {
        const ch = volume.chapters[i];

        // 抓取当前章节所有分页（节奏由 Pacer 统一控制，不会重复等待）
        let chResult;
        try {
          chResult = await this.scrapeSingleChapter(ch, (pageNum) => {
            updateStatus(`抓取中: 章节 ${i + 1}/${volume.chapters.length} (第${pageNum}页)...`);
          });
        } catch (err) {
          failedChapters++;
          console.warn(`[EPUB Downloader] 章节抓取失败，降级为占位页: ${ch.title}`, err);
          scrapedChapters.push({
            title: ch.title,
            paragraphs: [{ type: 'text', text: `[章节抓取失败] ${ch.title}（${err.message}）` }],
            imageUrls: [],
            nextChapterUrl: null,
          });
          continue;
        }

        // 正向修复下一章的 cid(0) 链接
        if (i + 1 < volume.chapters.length && !volume.chapters[i + 1].url && chResult.nextChapterUrl) {
          volume.chapters[i + 1].url = chResult.nextChapterUrl;
        }

        // 统计仍未还原的加密字符，向用户暴露解密覆盖率
        for (const para of chResult.paragraphs) {
          if (para.type === 'text') {
            undecryptedChars += this.fontDecryptor.countUndecrypted(para.text);
          }
        }

        // 插图丢进全局池：与后续章节的正文抓取并行，章节循环不再被图片阻塞
        for (const item of chResult.imageUrls) {
          if (imageRegistry.has(item.url) || pendingImages.has(item.url)) continue;
          pendingImages.add(item.url);
          totalImages += 1;

          imageJobs.push(
            ImagePool.add(async () => {
              const data = await this.downloadImageWithRetry(item.url, item.referer);
              if (staleImages) return;
              if (data) {
                const id = `img_${String(imgCounter++).padStart(4, '0')}`;
                imageRegistry.set(item.url, {
                  id,
                  filename: `${id}.${data.ext}`,
                  mime: data.mime,
                  buffer: data.buffer,
                });
              } else {
                imageRegistry.set(item.url, null); // 失败标记，生成 XHTML 时降级为文本
              }
              pendingImages.delete(item.url);
              completedImages += 1;
              updateStatus(`下载图片: ${completedImages}/${totalImages}...`);
            })
          );
        }

        scrapedChapters.push(chResult);
      }

      let imageTimedOut = 0;
      if (completedImages < totalImages) {
        updateStatus(
          `等待图片完成: ${completedImages}/${totalImages} (最多 ${Math.round(CONFIG.IMAGE_GRACE / 1000)}s)...`
        );
        await Promise.race([
          Promise.all(imageJobs).then(() => true),
          Utils.sleep(CONFIG.IMAGE_GRACE, CONFIG.IMAGE_GRACE).then(() => false),
        ]);
        if (completedImages < totalImages) {
          imageTimedOut = totalImages - completedImages;
          staleImages = true;
          // 未完成的图片统一记为 null，构建时降级为 [插图加载失败]，保证 registry 与 manifest 一致
          for (const url of pendingImages) {
            if (!imageRegistry.has(url)) imageRegistry.set(url, null);
          }
          pendingImages.clear();
          console.warn(
            `[EPUB Downloader] ${imageTimedOut} 张图片在宽限期内未完成，已跳过（打包继续，缺失处降级为提示文本）`,
            Array.from(pendingImages).slice(0, 5)
          );
        }
      }

      if (undecryptedChars > 0) {
        console.warn(
          `[EPUB Downloader] 本卷仍有 ${undecryptedChars} 个加密字符未能还原，请通过油猴菜单导入完整 PUA 字典后重试`
        );
      }

      return {
        volumeTitle: volume.title,
        coverData,
        chapters: scrapedChapters,
        imageRegistry,
        failedChapters,
        undecryptedChars,
        stats: {
          speed: SPEED.name,
          textRequests: this.textRequests,
          textWaits: Pacer.waits,
          images: totalImages,
          imageFailed: Array.from(imageRegistry.values()).filter((v) => !v).length,
          imageTimedOut,
          removedDecoys: this.removedDecoys,
          unscrambledPages: this.unscrambledPages,
          checkedPages: this.checkedPages,
          textMode: CONFIG.TEXT_FRAME && this.frameFailures < 3 ? 'frame' : 'xhr',
          scrapeMs: Date.now() - startedAt,
        },
      };
    }
  }

  /********************************************************************
   * 5. EPUB 2.0 封装构建器 (EpubBuilder - 对应边界 1A & 10A)
   ********************************************************************/
  /**
   * 轻量 ZIP 写入器（v1.4.0）
   *
   * 为什么不用 JSZip：JSZip 的 generateAsync 依赖 setImmediate/MessageChannel 分片调度，
   * 在部分 Tampermonkey 沙箱里会一直不回调（表现为「正在打包 EPUB...」永久卡住）。
   * 这里直接按 ZIP 规范写本地头/中央目录/EOCD，同步完成，无第三方依赖。
   */
  class ZipWriter {
    constructor() {
      this.entries = [];
    }

    /**
     * @param {string} name 包内路径（用 / 分隔）
     * @param {string|ArrayBuffer|Uint8Array} data
     * @param {{compress?: boolean}} options compress=true 时对文本尝试 deflate
     */
    add(name, data, { compress = false } = {}) {
      this.entries.push({ name, data, compress });
    }

    static get crcTable() {
      if (ZipWriter._crcTable) return ZipWriter._crcTable;
      const table = new Int32Array(256 * 8);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
      for (let n = 0; n < 256; n++) {
        let c = table[n];
        for (let k = 1; k < 8; k++) {
          c = table[c & 0xff] ^ (c >>> 8);
          table[256 * k + n] = c;
        }
      }
      ZipWriter._crcTable = table;
      return table;
    }

    /** slicing-by-8 CRC32，比逐字节快 3~4 倍 */
    static crc32(bytes) {
      const t = ZipWriter.crcTable;
      let crc = -1;
      let i = 0;
      const len = bytes.length;
      const end8 = len - (len % 8);
      for (; i < end8; i += 8) {
        crc ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
        crc =
          t[7 * 256 + (crc & 0xff)] ^
          t[6 * 256 + ((crc >>> 8) & 0xff)] ^
          t[5 * 256 + ((crc >>> 16) & 0xff)] ^
          t[4 * 256 + ((crc >>> 24) & 0xff)] ^
          t[3 * 256 + bytes[i + 4]] ^
          t[2 * 256 + bytes[i + 5]] ^
          t[1 * 256 + bytes[i + 6]] ^
          t[bytes[i + 7]];
      }
      for (; i < len; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
      return (crc ^ -1) >>> 0;
    }

    /** 原生 deflate（Chrome 103+），不可用时返回 null 由调用方降级为 STORE */
    static async deflateRaw(bytes) {
      if (typeof CompressionStream === 'undefined') return null;
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (err) {
        return null;
      }
    }

    static toBytes(data) {
      if (typeof data === 'string') return new TextEncoder().encode(data);
      if (data instanceof Uint8Array) return data;
      return new Uint8Array(data);
    }

    /** 生成 zip Blob；onProgress(percent) 可选 */
    async build(onProgress) {
      const chunks = [];
      const central = [];
      const encoder = new TextEncoder();
      const now = new Date();
      const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
      const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
      let offset = 0;

      for (let index = 0; index < this.entries.length; index++) {
        const entry = this.entries[index];
        const nameBytes = encoder.encode(entry.name);
        const raw = ZipWriter.toBytes(entry.data);

        let method = 0;
        let payload = raw;
        if (entry.compress) {
          const deflated = await ZipWriter.deflateRaw(raw);
          if (deflated && deflated.length > 0 && deflated.length < raw.length) {
            method = 8;
            payload = deflated;
          }
        }

        const crc = ZipWriter.crc32(raw);
        const local = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(local.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 0x0800, true); // 文件名 UTF-8
        dv.setUint16(8, method, true);
        dv.setUint16(10, dosTime, true);
        dv.setUint16(12, dosDate, true);
        dv.setUint32(14, crc, true);
        dv.setUint32(18, payload.length, true);
        dv.setUint32(22, raw.length, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        local.set(nameBytes, 30);

        chunks.push(local, payload);
        central.push({
          nameBytes,
          method,
          crc,
          csize: payload.length,
          usize: raw.length,
          offset,
          dosTime,
          dosDate,
        });
        offset += local.length + payload.length;

        if (onProgress) onProgress(Math.round(((index + 1) / this.entries.length) * 95));
      }

      const cdStart = offset;
      let cdSize = 0;
      for (const e of central) {
        const header = new Uint8Array(46 + e.nameBytes.length);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 0x02014b50, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, e.method, true);
        dv.setUint16(12, e.dosTime, true);
        dv.setUint16(14, e.dosDate, true);
        dv.setUint32(16, e.crc, true);
        dv.setUint32(20, e.csize, true);
        dv.setUint32(24, e.usize, true);
        dv.setUint16(28, e.nameBytes.length, true);
        dv.setUint16(30, 0, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, e.offset, true);
        header.set(e.nameBytes, 46);
        chunks.push(header);
        cdSize += header.length;
      }

      const eocd = new Uint8Array(22);
      const dv = new DataView(eocd.buffer);
      dv.setUint32(0, 0x06054b50, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, central.length, true);
      dv.setUint16(10, central.length, true);
      dv.setUint32(12, cdSize, true);
      dv.setUint32(16, cdStart, true);
      dv.setUint16(20, 0, true);
      chunks.push(eocd);

      if (onProgress) onProgress(100);
      return new Blob(chunks, { type: 'application/epub+zip' });
    }
  }

  class EpubBuilder {
    static async build(bookMeta, volumeData, updateStatus) {
      const startedAt = Date.now();
      let imageBytes = 0;
      let imageCount = 0;
      updateStatus('正在打包 EPUB...');

      const zip = new ZipWriter();
      const uuid =
        'urn:uuid:' +
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : EpubBuilder.uuidFallback());
      const fullTitle = `${bookMeta.bookTitle} - ${volumeData.volumeTitle}`;

      // 1. mimetype (必须置于首个文件且无压缩)
      zip.add('mimetype', 'application/epub+zip');

      // 2. META-INF/container.xml
      zip.add(
        'META-INF/container.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
      );

      // 3. 样式表 OEBPS/Styles/main.css (边界 10A: 自适应流式插图)
      zip.add(
        'OEBPS/Styles/main.css',
        `body {
  font-family: "PingFang SC", "Microsoft YaHei", serif;
  line-height: 1.8;
  margin: 5%;
  text-align: justify;
}
h1, h2 {
  text-align: center;
  font-weight: bold;
  margin: 1.2em 0 0.8em 0;
  page-break-after: avoid;
}
p {
  text-indent: 2em;
  margin: 0.5em 0;
}
.illustration {
  text-align: center;
  margin: 1em 0;
  text-indent: 0;
  page-break-inside: avoid;
}
.illustration img {
  max-width: 100%;
  height: auto;
}
.img-fallback {
  text-align: center;
  color: #888888;
  font-size: 0.9em;
  text-indent: 0;
  margin: 0.8em 0;
}`,
        { compress: true }
      );

      const manifestItems = [
        `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
        `<item id="css" href="Styles/main.css" media-type="text/css"/>`,
      ];
      const spineItems = [];
      const navPoints = [];
      let playOrder = 1;

      // 4. 写入分卷封面图片与封面页
      if (volumeData.coverData) {
        const c = volumeData.coverData;
        zip.add(`OEBPS/Images/${c.filename}`, c.buffer);
        imageBytes += c.buffer.byteLength;
        imageCount += 1;
        manifestItems.push(
          `<item id="cover-image" href="Images/${c.filename}" media-type="${c.mime}"/>`
        );
        zip.add(
          'OEBPS/Text/cover.xhtml',
          `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>封面</title>
  <link href="../Styles/main.css" rel="stylesheet" type="text/css"/>
</head>
<body>
  <div class="illustration">
    <img src="../Images/${c.filename}" alt="cover"/>
  </div>
</body>
</html>`
        );
        manifestItems.push(
          `<item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>`
        );
        spineItems.push(`<itemref idref="cover-page"/>`);
      }

      // 5. 写入所有成功下载的插图文件
      for (const imgInfo of volumeData.imageRegistry.values()) {
        if (imgInfo) {
          zip.add(`OEBPS/Images/${imgInfo.filename}`, imgInfo.buffer);
          imageBytes += imgInfo.buffer.byteLength;
          imageCount += 1;
          manifestItems.push(
            `<item id="${imgInfo.id}" href="Images/${imgInfo.filename}" media-type="${imgInfo.mime}"/>`
          );
        }
      }

      // 6. 生成各章节 XHTML
      volumeData.chapters.forEach((ch, idx) => {
        const chId = `chapter_${String(idx + 1).padStart(3, '0')}`;
        const chFile = `${chId}.xhtml`;
        const safeTitle = Utils.escapeXml(ch.title);

        const bodyLines = [`  <h2>${safeTitle}</h2>`];
        for (const para of ch.paragraphs) {
          if (para.type === 'text') {
            bodyLines.push(`  <p>${Utils.escapeXml(para.text)}</p>`);
          } else if (para.type === 'image') {
            const imgMeta = volumeData.imageRegistry.get(para.url);
            if (imgMeta) {
              bodyLines.push(
                `  <div class="illustration"><img src="../Images/${imgMeta.filename}" alt=""/></div>`
              );
            } else {
              // 边界 5A: 3 次重试仍失败时降级为提示文本
              bodyLines.push(`  <p class="img-fallback">[插图加载失败]</p>`);
            }
          }
        }

        const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>${safeTitle}</title>
  <link href="../Styles/main.css" rel="stylesheet" type="text/css"/>
</head>
<body>
${bodyLines.join('\n')}
</body>
</html>`;

        zip.add(`OEBPS/Text/${chFile}`, xhtml, { compress: true });
        manifestItems.push(
          `<item id="${chId}" href="Text/${chFile}" media-type="application/xhtml+xml"/>`
        );
        spineItems.push(`<itemref idref="${chId}"/>`);
        navPoints.push(`    <navPoint id="navPoint-${playOrder}" playOrder="${playOrder}">
      <navLabel><text>${safeTitle}</text></navLabel>
      <content src="Text/${chFile}"/>
    </navPoint>`);
        playOrder++;
      });

      // 7. 生成 content.opf
      const coverMetaTag = volumeData.coverData
        ? `<meta name="cover" content="cover-image"/>`
        : '';
      // EPUB 2 可选但主流阅读器依赖的封面指引
      const guideBlock = volumeData.coverData
        ? `
  <guide>
    <reference type="cover" title="封面" href="Text/cover.xhtml"/>
  </guide>`
        : '';
      zip.add(
        'OEBPS/content.opf',
        `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${Utils.escapeXml(fullTitle)}</dc:title>
    <dc:creator opf:role="aut">${Utils.escapeXml(bookMeta.author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookId" opf:scheme="UUID">${uuid}</dc:identifier>
    ${coverMetaTag}
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>${guideBlock}
</package>`,
        { compress: true }
      );

      // 8. 生成 toc.ncx
      zip.add(
        'OEBPS/toc.ncx',
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${Utils.escapeXml(fullTitle)}</text></docTitle>
  <navMap>
${navPoints.join('\n')}
  </navMap>
</ncx>`,
        { compress: true }
      );

      // 9. 生成 Blob 并触发浏览器下载（带进度回显，避免大卷时按钮长时间无反馈）
      const zipStartedAt = Date.now();
      let lastPercent = -1;
      const blob = await zip.build((pct) => {
        if (pct === lastPercent) return;
        lastPercent = pct;
        updateStatus(`打包中: ${pct}%...`);
      });
      const zipMs = Date.now() - zipStartedAt;

      const downloadName = `${Utils.sanitizeFilename(fullTitle)}.epub`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.remove();
      }, 5000);

      const totalMs = Date.now() - startedAt;
      const imageMB = +(imageBytes / 1048576).toFixed(1);
      console.info('[EPUB Downloader] 打包拆解', {
        files: manifestItems.length,
        images: imageCount,
        imageMB,
        zipMs,
        totalMs,
        sizeMB: +(blob.size / 1048576).toFixed(1),
      });

      // 返回产物，便于测试/二次复用
      return { blob, downloadName, stats: { zipMs, totalMs, imageMB, sizeMB: +(blob.size / 1048576).toFixed(1), images: imageCount } };
    }

    /**
     * 非安全上下文（crypto.randomUUID 缺失）时的 UUID 兜底
     */
    static uuidFallback() {
      const hex = (n) =>
        Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
    }
  }

  /********************************************************************
   * 6. 界面挂载与内联进度控制器 (UIController - 对应边界 2, 7A, 9A)
   ********************************************************************/
  class UIController {
    static injectStyles() {
      const style = document.createElement('style');
      style.textContent = `
        .linovelib-epub-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          margin-left: 8px;
          padding: 4px 12px;
          font-size: 13px;
          font-weight: 500;
          line-height: 1.5;
          color: #ffffff !important;
          background-color: #00a1d6;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          text-decoration: none !important;
          transition: background-color 0.2s ease;
          vertical-align: middle;
        }
        .linovelib-epub-btn:hover {
          background-color: #00b5e5;
        }
        .linovelib-epub-btn.is-loading {
          background-color: #f59e0b;
          cursor: wait;
          pointer-events: none;
        }
        .linovelib-epub-btn.is-done {
          background-color: #10b981;
        }
        .linovelib-epub-btn.is-error {
          background-color: #ef4444;
        }
      `;
      document.head.appendChild(style);
    }

    /**
     * 创建分卷下载按钮
     * @param {{index?: number, order?: number, titleHint?: string}} hint
     *        index 为解析后的连续分卷序号，order 为页面 DOM 序号，titleHint 为页面上的分卷标题
     */
    static createDownloadButton({ index = 0, order = 0, titleHint = '' } = {}) {
      const btn = document.createElement('a');
      btn.href = 'javascript:void(0);';
      btn.className = 'linovelib-epub-btn';
      btn.textContent = 'EPUB下载';
      const label = titleHint || `第 ${index + 1} 卷`;
      btn.title = `下载本卷 EPUB (${label})`;

      let isRunning = false;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isRunning) return;

        // 全局限流：同一时间只允许一个分卷在跑，避免双路抓取触发站点 429
        if (ACTIVE_DOWNLOAD) {
          btn.title = '已有分卷正在下载，请等待其完成';
          return;
        }

        isRunning = true;
        ACTIVE_DOWNLOAD = label;
        btn.classList.remove('is-done', 'is-error');
        btn.classList.add('is-loading');
        btn.title = `正在下载: ${label}`;

        const updateStatus = (text) => {
          btn.textContent = text;
        };

        const timings = { startedAt: Date.now() };
        try {
          const bookId = CatalogResolver.getBookId();
          if (!bookId) throw new Error('无法识别书籍 ID');

          let bookMeta;
          let targetVolume;
          let allVolumes;

          if (UIController.isVolumePage()) {
            // 分卷详情页：本页已有所属分卷的章节列表，直接用，省掉目录页请求
            updateStatus('读取本卷目录...');
            bookMeta = await UIController.loadBookMeta(bookId);
            targetVolume = UIController.parseCurrentVolumePage();
            if (!targetVolume.chapters.length) {
              throw new Error('本页未找到章节链接');
            }
            allVolumes = [targetVolume];
            console.log('[EPUB Downloader] VolumeMeta', targetVolume, bookMeta);
            updateStatus(`本卷 ${targetVolume.chapters.length} 章，开始抓取...`);
          } else {
            updateStatus('解析目录中...');
            bookMeta = await CatalogResolver.resolveBookCatalog(bookId);
            // Phase 1 AC-2：把解析结果打到控制台，便于核对分卷/章节结构
            console.log('[EPUB Downloader] BookCatalog', bookMeta);

            targetVolume = UIController.pickVolume(bookMeta.volumes, {
              index,
              order,
              titleHint,
            });
            if (!targetVolume) {
              throw new Error(`未找到对应分卷 (索引 ${index} / 标题 ${label})`);
            }
            allVolumes = bookMeta.volumes;
          }

          timings.metaMs = Date.now() - timings.startedAt;

          const fontDecryptor = new FontDecryptor();
          const scraper = new ChapterScraper(fontDecryptor);

          const volumeData = await scraper.scrapeVolume(
            targetVolume,
            allVolumes,
            updateStatus,
            bookMeta
          );
          timings.scrapeMs = Date.now() - timings.startedAt - timings.metaMs;

          const built = await EpubBuilder.build(bookMeta, volumeData, updateStatus);
          timings.buildMs = Date.now() - timings.startedAt - timings.metaMs - timings.scrapeMs;
          timings.totalMs = Date.now() - timings.startedAt;

          console.info('[EPUB Downloader] 用时统计(ms)', {
            ...timings,
            speed: volumeData.stats.speed,
            chapters: volumeData.chapters.length,
            textRequests: volumeData.stats.textRequests,
            textWaits: volumeData.stats.textWaits,
            images: volumeData.stats.images,
            imageFailed: volumeData.stats.imageFailed,
          });

          btn.classList.remove('is-loading');
          btn.classList.add('is-done');
          const warnParts = [];
          if (volumeData.failedChapters > 0) warnParts.push(`${volumeData.failedChapters} 章失败`);
          if (volumeData.undecryptedChars > 0) warnParts.push(`${volumeData.undecryptedChars} 字未解密`);
          const packInfo = built && built.stats ? `${built.stats.sizeMB}MB/${(built.stats.totalMs / 1000).toFixed(1)}s` : '';
          updateStatus(
            warnParts.length
              ? `完成(${warnParts.join('/')})`
              : packInfo
                ? `打包完成 ${packInfo} (点击重下)`
                : '打包完成 (点击重下)'
          );
          btn.title = warnParts.length
            ? `《${label}》已导出，但${warnParts.join('，')}；详见控制台`
            : `《${label}》已导出`;
        } catch (err) {
          console.error('[EPUB Downloader] 分卷下载异常:', err);
          btn.classList.remove('is-loading');
          btn.classList.add('is-error');
          const message = String((err && err.message) || err);
          updateStatus(`失败: ${message.slice(0, 24)} (点击重试)`);
          btn.title = message; // 完整错误进 title，避免截断丢失关键信息
        } finally {
          isRunning = false;
          ACTIVE_DOWNLOAD = null;
        }
      });

      return btn;
    }

    /**
     * 从解析结果中挑出目标分卷：标题优先（双向包含），其次 DOM 序号，最后连续索引
     */
    static pickVolume(volumes, { index = 0, order = 0, titleHint = '' } = {}) {
      if (!Array.isArray(volumes) || volumes.length === 0) return null;
      const hint = Utils.normalizeTitle(titleHint);

      if (hint) {
        const exact = volumes.find((v) => Utils.normalizeTitle(v.title) === hint);
        if (exact) return exact;
        const contains = volumes.find((v) => {
          const t = Utils.normalizeTitle(v.title);
          // t 过短（如扁平结构兜底的"正文"）时不做反向包含，避免误命中
          if (!t) return false;
          return t.includes(hint) || (t.length >= 4 && hint.includes(t));
        });
        if (contains) return contains;
      }

      // 卷号匹配：详情页可能倒序列卷（7..1），此时 index/order 都不可靠
      const hintNum = Utils.parseVolumeNumber(titleHint);
      if (hintNum !== null) {
        const byNumber = volumes.filter(
          (v) => Utils.parseVolumeNumber(v.title) === hintNum
        );
        if (byNumber.length === 1) return byNumber[0];
      }

      return (
        volumes.find((v) => v.order === order) ||
        volumes.find((v) => v.index === index) ||
        volumes[index] ||
        null
      );
    }

    /**
     * 找出分卷容器：优先站点实际模板 div.volume.clearfix，其次 .volume-info
     */
    static findVolumeBlocks(root = document) {
      if (!root || !root.querySelectorAll) return [];
      const blocks = Array.from(root.querySelectorAll('.volume'));
      return blocks.length > 0 ? blocks : Array.from(root.querySelectorAll('.volume-info'));
    }

    /** 是否为分卷详情页 /novel/{id}/vol_{volId}.html */
    static isVolumePage() {
      return /\/novel\/\d+\/vol_\d+\.html/.test(location.pathname);
    }

    /** 从当前分卷详情页解析出本卷标题、封面与章节列表 */
    static parseCurrentVolumePage() {
      const bookId = this.currentBookId();
      const re = new RegExp(`/novel/${bookId}/\\d+`);
      const h1 = document.querySelector('h1.book-name, .book-name, h1');
      const volumeTitle =
        Utils.textWithoutButton(h1) || (document.title || '').split(/[-_|]/)[0].trim() || '本卷';

      const chapters = [];
      const seen = new Set();
      const listRoot =
        document.querySelector('.book-new-chapter, #volume-list, .chapter-list, .book-chapter-list') ||
        document;
      let anchors = Array.from(listRoot.querySelectorAll('a[href]'));
      if (!anchors.some((a) => re.test(a.getAttribute('href') || ''))) {
        anchors = Array.from(document.querySelectorAll('a[href]'));
      }

      for (const a of anchors) {
        if (a.closest && a.closest('.linovelib-epub-btn')) continue;
        const href = a.getAttribute('href') || '';
        if (!re.test(href)) continue;
        const url = Utils.resolveUrl(href);
        const title = a.textContent.trim();
        if (!url || !title || seen.has(url)) continue;
        seen.add(url);
        chapters.push({ title, url });
      }

      const coverEl = document.querySelector('.book-img img');
      const coverUrl =
        Utils.resolveUrl(
          document.querySelector('meta[property="og:image"]')?.content ||
            coverEl?.getAttribute('data-src') ||
            coverEl?.getAttribute('src') ||
            ''
        ) || null;

      return { index: 0, order: 0, title: volumeTitle, coverUrl, chapters };
    }

    /**
     * 读取书籍级元数据（书名/作者/总封面）
     * 分卷页的 og:novel:book_name 是本卷名，必须回到书籍详情页取书名
     */
    static async loadBookMeta(bookId) {
      const cacheKey = `book_meta_${bookId}`;
      const cached = GM_getValue(cacheKey, null);
      if (cached && cached.bookTitle && Date.now() - (cached.ts || 0) < 7 * 24 * 3600 * 1000) {
        return cached;
      }

      const detailUrl = `${location.origin}/novel/${bookId}.html`;
      const fallbackTitle = (document.title || '').split(/[-_|]/)[0].trim() || `Novel_${bookId}`;
      try {
        const { doc } = await Utils.fetchDoc(detailUrl);
        const bookTitle =
          doc.querySelector('meta[property="og:novel:book_name"]')?.content?.trim() ||
          Utils.textWithoutButton(doc.querySelector('h1.book-name, .book-name, h1')) ||
          fallbackTitle;
        const author =
          doc.querySelector('meta[property="og:novel:author"]')?.content?.trim() ||
          Utils.textWithoutButton(doc.querySelector('.au-name a, .book-rand-a a')) ||
          '未知作者';
        const bookCover =
          Utils.resolveUrl(
            doc.querySelector('meta[property="og:image"]')?.content ||
              doc.querySelector('.book-img img')?.getAttribute('src') ||
              ''
          ) || '';
        const meta = { bookId, bookTitle, author, bookCover, detailUrl, ts: Date.now() };
        GM_setValue(cacheKey, meta);
        return meta;
      } catch (err) {
        console.warn('[EPUB Downloader] 书籍详情页获取失败，退回当前页信息:', err);
        return { bookId, bookTitle: fallbackTitle, author: '未知作者', bookCover: '', detailUrl };
      }
    }

    /** 分卷详情页挂载点：优先"目录"标题，其次章节列表容器 */
    static findVolumePageHosts() {
      const titleEl =
        Array.from(document.querySelectorAll('h2, h3, h4, .h3-vol, .chapter-bar')).find((h) =>
          /^(目录|章节目录|本卷目录|正文)$/.test(Utils.normalizeTitle(Utils.textWithoutButton(h)))
        ) || null;

      const host =
        titleEl ||
        document.querySelector('.book-new-chapter') ||
        document.querySelector('#volume-list, .chapter-list, .book-chapter-list') ||
        document.querySelector('h1.book-name');

      if (!host) return [];

      return [
        {
          card: host,
          host,
          titleEl,
          title: Utils.textWithoutButton(document.querySelector('h1.book-name, .book-name, h1')),
          order: 0,
          mode: titleEl ? undefined : 'before-host',
        },
      ];
    }

    /** 当前书籍 ID（用于限定章节链接属于本书） */
    static currentBookId() {
      const m = location.pathname.match(/\/novel\/(\d+)/);
      return m ? m[1] : null;
    }

    /**
     * 目录页挂载点，按可靠性分四级：
     * A 已知容器 → B 章节链接回溯标题 → C .chapter-bar → D 整页单按钮
     */
    static findCatalogVolumeHosts() {
      const bookId = this.currentBookId();

      const blocks = this.findVolumeBlocks(document).filter(
        (b) => Utils.chapterLinksIn(b, bookId).length > 0
      );
      if (blocks.length > 0) {
        return blocks.map((block, order) => {
          const titleEl = block.querySelector('h2.v-line, .v-line, .v-title, .sub-tit, h2, h3');
          return {
            card: block,
            host: titleEl || block,
            titleEl,
            title: Utils.textWithoutButton(titleEl),
            order,
          };
        });
      }

      const links = Utils.chapterLinksIn(document, bookId);

      if (links.length > 0) {
        const headers = Utils.headersForLinks(links, bookId);
        if (headers.length > 0) return this.hostsFromHeaders(headers);
      }

      const bars = Array.from(
        document.querySelectorAll('#volume-list .chapter-bar, #volumes .chapter-bar, .chapter-bar')
      );
      if (bars.length > 0) {
        return bars.map((el, order) => ({
          card: el,
          host: el,
          titleEl: null,
          title: Utils.textWithoutButton(el),
          order,
        }));
      }

      if (links.length > 0) {
        const lca = Utils.commonAncestor(links);
        if (lca) {
          return [
            { card: lca, host: lca, titleEl: null, title: '正文', order: 0, mode: 'before-host' },
          ];
        }
      }
      return [];
    }

    /**
     * 详情页挂载点：已知容器 → 通用"卷名标题"（支持 "书名 7 / 书名 6 …" 倒序排列）
     */
    static findDetailVolumeHosts() {
      const blocks = this.findVolumeBlocks(document);
      const cards =
        blocks.length > 0
          ? blocks
          : Array.from(
              document.querySelectorAll(
                '.book-vol-list .vol-item, #volume-list .volume-info, .section_list li'
              )
            );

      if (cards.length > 0) {
        return cards.map((card, order) => {
          const titleEl = card.querySelector(
            'h2.v-line, .v-line, .v-title, .vol-title, h2, h3, h4, .section_title'
          );
          const actionArea = card.querySelector('.v-btn, .vol-btns, .volume-btn') || titleEl || card;
          return {
            card,
            host: actionArea,
            titleEl,
            title: Utils.textWithoutButton(titleEl),
            order,
          };
        });
      }

      const bookTitle = Utils.currentBookTitle();
      const heads = Array.from(
        document.querySelectorAll('h2, h3, h4, .v-title, .vol-title, .volume-title, .section_title')
      ).filter((h) => Utils.looksLikeVolumeTitle(Utils.textWithoutButton(h), bookTitle));

      if (heads.length >= 2) return this.hostsFromHeaders(heads);

      if (heads.length === 1) {
        const box = heads[0].parentElement;
        if (box && (box.querySelector('img') || box.querySelector('a[href]'))) {
          return this.hostsFromHeaders(heads);
        }
      }

      return [];
    }

    static hostsFromHeaders(headers, startOrder = 0) {
      return headers.map((h, i) => ({
        card: h,
        host: h,
        titleEl: h,
        title: Utils.textWithoutButton(h),
        order: startOrder + i,
      }));
    }

    static findVolumeHosts() {
      return /\/novel\/\d+\/catalog/.test(location.pathname)
        ? this.findCatalogVolumeHosts()
        : this.findDetailVolumeHosts();
    }

    /** 按描述符插入按钮；返回本次新挂载的数量 */
    static placeButtons(hosts) {
      let mounted = 0;
      for (const { card, host, titleEl, title, order, mode } of hosts) {
        if (!card || !card.dataset || card.dataset.linovelibMounted === '1') continue;
        card.dataset.linovelibMounted = '1';

        const btn = this.createDownloadButton({ index: order, order, titleHint: title });
        let anchorEl = titleEl;
        if (anchorEl && anchorEl.closest) {
          const wrapped = anchorEl.closest('a');
          if (wrapped) anchorEl = wrapped; // 标题被 <a> 包裹时插到链接之后，避免点击按钮触发跳转
        }
        if (mode === 'before-host' && host && host.parentNode) {
          host.parentNode.insertBefore(btn, host);
        } else if (anchorEl && anchorEl.parentNode) {
          // 插在分卷标题之后而不是塞进标题里，避免卷名被按钮文案污染
          anchorEl.parentNode.insertBefore(btn, anchorEl.nextSibling);
        } else if (host) {
          host.appendChild(btn);
        }
        mounted++;
      }
      if (mounted > 0) console.info(`[EPUB Downloader] 已挂载 ${mounted} 个分卷下载按钮`);
      return mounted;
    }

    /**
     * 在书籍详情页 (/novel/{id}.html) 与目录页 (/novel/{id}/catalog) 注入下载按钮
     * 轮询 + MutationObserver 双保险，覆盖异步渲染
     */
    static mountButtons() {
      // 仅在分卷详情页挂载：书籍汇总页/目录页不再注入，避免按钮堆叠、位置错乱
      if (!this.isVolumePage()) return;

      if (!this.stylesInjected) {
        this.injectStyles();
        this.stylesInjected = true;
      }

      let attempts = 0;
      const tick = () => {
        attempts++;
        const hosts = this.findVolumePageHosts();
        if (hosts.length > 0) {
          this.placeButtons(hosts);
          if (this.volumeObserver) {
            this.volumeObserver.disconnect();
            this.volumeObserver = null;
          }
          return;
        }
        if (attempts < CONFIG.MOUNT_RETRY_TIMES) {
          setTimeout(tick, CONFIG.MOUNT_RETRY_INTERVAL);
        } else {
          this.reportMountFailure();
        }
      };

      tick();
      this.watchVolumeList();
    }

    /** 监听 DOM 变化，分卷列表异步渲染出来后补挂 */
    static watchVolumeList() {
      if (this.volumeObserver || typeof MutationObserver === 'undefined' || !document.body) return;
      if (document.querySelectorAll('.linovelib-epub-btn').length > 0) return;

      let pending = null;
      this.volumeObserver = new MutationObserver(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          this.mountButtons();
        }, 400);
      });
      this.volumeObserver.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        if (this.volumeObserver) {
          this.volumeObserver.disconnect();
          this.volumeObserver = null;
        }
      }, 60000);
    }

    /** 挂载失败时输出可复制的诊断信息，便于定位站点改版 */
    static reportMountFailure() {
      const q = (sel) => document.querySelectorAll(sel).length;
      const counts = {};
      ['#volume-list', '#volumes', '.volume-list', '.book-vol-list', '.chapter-bar', '.v-line', '.volume', '.volume-info', 'li.col-4'].forEach(
        (sel) => {
          counts[sel] = q(sel);
        }
      );

      const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
        const href = a.getAttribute('href') || '';
        return /\/novel\/\d+\/\d+/.test(href) || /cid\(0\)/.test(href);
      });
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
        .slice(0, 12)
        .map((h) => {
          const cls = typeof h.className === 'string' ? h.className.trim().replace(/\s+/g, '.') : '';
          return `${h.tagName}.${cls} :: ${Utils.textWithoutButton(h).slice(0, 24)}`;
        });
      const lca = links.length > 0 ? Utils.commonAncestor(links) : null;
      const bookTitle = Utils.currentBookTitle();
      const volumeHead = Array.from(document.querySelectorAll('h1, h2, h3, h4')).find((h) =>
        Utils.looksLikeVolumeTitle(Utils.textWithoutButton(h), bookTitle)
      );

      console.warn('[EPUB Downloader] 未找到可分卷容器，未挂载下载按钮');
      console.info('[EPUB Downloader] 诊断信息（请把这段贴给开发者）', {
        url: location.href,
        pathname: location.pathname,
        counts,
        chapterLinks: links.length,
        firstLinks: links.slice(0, 3).map((a) => a.getAttribute('href')),
        headings,
        listContainer: lca
          ? `${lca.tagName}.${typeof lca.className === 'string' ? lca.className : ''}`
          : null,
        listHtml: lca ? String(lca.outerHTML || '').slice(0, 600) : null,
        bookTitle,
        volumeHeadHtml: volumeHead
          ? String((volumeHead.parentElement || volumeHead).outerHTML || '').slice(0, 800)
          : null,
      });
    }

    /**
     * 注册油猴菜单命令：导入 PUA 字符字典 / 轮廓 Hash 字典，清理字体缓存
     */
    static registerMenuCommands() {
      GM_registerMenuCommand(`⚡ 下载速度（当前：${SPEED.name}）→ 切换快速`, () => {
        const name = SPEED.apply('fast');
        GM_setValue('speed_profile', name);
        alert('已切换到「快速」：正文间隔 500~900ms，插图 6 并发');
      });

      GM_registerMenuCommand('🚀 下载速度 → 切换极速（风控风险较高）', () => {
        const name = SPEED.apply('turbo');
        GM_setValue('speed_profile', name);
        alert('已切换到「极速」：正文间隔 250~500ms，插图 8 并发；若触发限速会自动降档');
      });

      GM_registerMenuCommand('🐢 下载速度 → 切换标准（原设计基线）', () => {
        const name = SPEED.apply('safe');
        GM_setValue('speed_profile', name);
        alert('已切换到「标准」：正文间隔 800~1500ms，插图 3 并发');
      });

      GM_registerMenuCommand('📥 导入 PUA 字符字典 (JSON, 如 bilinovel-download)', () => {
        const input = prompt(
          '请粘贴 PUA 字符映射 JSON（格式如 {"\\ue800":"的"}）：',
          JSON.stringify(GM_getValue('custom_static_pua_map', {}))
        );
        if (!input) return;
        try {
          const parsed = JSON.parse(input);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('必须是对象');
          }
          GM_setValue('custom_static_pua_map', parsed);
          GM_setValue('cached_font_url', '');
          alert(`成功导入 ${Object.keys(parsed).length} 个字符映射，刷新页面后生效！`);
        } catch (err) {
          alert('JSON 格式有误: ' + err.message);
        }
      });

      GM_registerMenuCommand('📥 导入轮廓 Hash 字典 (JSON, 8位hex -> 汉字)', () => {
        const input = prompt(
          '请粘贴字形轮廓 Hash 映射 JSON（格式如 {"a1b2c3d4":"的"}）：',
          JSON.stringify(GM_getValue('custom_glyph_hash_map', {}))
        );
        if (!input) return;
        try {
          const parsed = JSON.parse(input);
          const keys = Object.keys(parsed || {});
          const invalid = keys.filter((k) => !/^[0-9a-f]{8}$/i.test(k));
          if (invalid.length > 0) {
            throw new Error(`存在非 8 位 hex 的键，例如 ${invalid[0]}`);
          }
          GM_setValue('custom_glyph_hash_map', parsed);
          GM_setValue('cached_font_url', '');
          alert(`成功导入 ${keys.length} 条轮廓映射，刷新页面后生效！`);
        } catch (err) {
          alert('JSON 格式有误: ' + err.message);
        }
      });

      GM_registerMenuCommand('🗑️ 清空字体动态缓存', () => {
        GM_setValue('cached_dynamic_pua_map', {});
        GM_setValue('cached_font_url', '');
        alert('字体动态缓存已清空！');
      });

      GM_registerMenuCommand('🧹 清空全部字体字典与缓存', () => {
        if (!confirm('将清空内置之外的全部 PUA/轮廓字典与字体缓存，确定？')) return;
        GM_setValue('custom_static_pua_map', {});
        GM_setValue('custom_glyph_hash_map', {});
        GM_setValue('cached_dynamic_pua_map', {});
        GM_setValue('cached_font_url', '');
        alert('已清空，刷新页面后生效！');
      });
    }
  }

  // 启动入口
  UIController.registerMenuCommands();
  UIController.mountButtons();

  // 调试/测试出口：暴露内部模块，便于在控制台核对解析结果与做无头测试
  try {
    globalThis.__BILINOVEL_EPUB__ = {
      CONFIG,
      SPEED,
      Pacer,
      ImagePool,
      ZipWriter,
      Utils,
      FontDecryptor,
      CatalogResolver,
      ChapterScraper,
      EpubBuilder,
      UIController,
    };
  } catch (err) {
    /* 沙箱不支持 globalThis 时忽略 */
  }
})();
