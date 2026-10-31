# 超星学习通 · 任务点自动跳转

一个 Tampermonkey 用户脚本：**当前任务点完成后自动进入下一个未完成任务点，并自动把新视频点起来**；切到别的应用全屏、标签页在后台时同样有效。

> 只读取页面状态并模拟正常点击，**不发送任何伪造进度的请求**，视频仍然要真实播放。

---

## 功能

- **完成即跳**：任务点一被标记「已完成」，约 1 秒后自动进入下一个未完成任务点，中间已完成的节点自动跳过。
- **结束即跳**：视频触发 `ended` 或进度 ≥ 99% 就算播完，不用等平台慢慢回调。
- **超时不卡**：平台迟迟不标记完成时，超时强制往下走（默认 6 秒，可配置）。
- **自动播放**：进入新视频后按「播放器 API → 大播放按钮 → `play()` → 静音兜底」四级降级拉起播放。
- **后台可用**：整条链路是事件驱动（`ended` + `MutationObserver`），不依赖被节流的定时器，所以切到别的应用全屏时也能继续。
- **悬浮面板**：显示当前任务点、完成进度、实时日志，并提供暂停 / 下一个 / 重扫 / 诊断。

## 安装

### 方式一：一键安装（推荐）

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge / Firefox 均可）。
2. 点击下面的链接，Tampermonkey 会弹出安装页，点「安装」：

   ```
   https://raw.githubusercontent.com/<your-name>/chaoxing-auto-next/main/chaoxing-auto-next.user.js
   ```

3. 打开课程学习页（`.../mycourse/studentstudy?...`），右上角出现深色面板即生效。

### 方式二：手动粘贴

1. Tampermonkey → 管理面板 → **+** 新建脚本。
2. 清空模板，粘贴 `chaoxing-auto-next.user.js` 全部内容，`Ctrl + S` 保存。
3. 刷新课程页面。

## 使用

打开课程页面后，右上角会显示一个深色面板：

| 区域 | 说明 |
| --- | --- |
| `自动播放 开/关` | 点击切换是否自动拉起新视频（状态保存在 localStorage） |
| 当前 / 进度 | 当前任务点名称、已完成数 / 总数 |
| 暂停 / 继续 | 暂停监测（不会自动跳转），刷新后状态保留 |
| 下一个 | 手动立即跳到下一个未完成任务点 |
| 重扫 | 重新扫描左侧目录（目录异步加载时有用） |
| 诊断 | 把页面结构信息输出到控制台并复制到剪贴板，排查用 |

正常运行时，日志大致如下：

```
[10:12:03] 已启动，共 42 个任务点
[10:12:03] 当前：1.1 视频导论
[10:16:31] 视频播放结束，等待平台标记（最多 6s）
[10:16:32] → 下一个：1.2 课程文档（已完成）
[10:16:33] 已启动，共 42 个任务点
```

## 配置

所有参数都可以在浏览器控制台里覆盖（改完刷新页面生效）：

```js
localStorage.setItem('cxAutoNext.cfg', JSON.stringify({
  endMaxWaitMs: 15000,   // 视频结束后最多等平台多久（毫秒），超时强跳
  forceAfterEnd: true,   // 超时后是否强制跳
  jumpAlreadyDone: false // 打开一个早就完成的章节时，是否也自动跳走
}));
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `pollMs` | `1200` | 轮询间隔（毫秒） |
| `doneSettleMs` | `1200` | 检测到「已完成」后再等多久才跳，防误判 |
| `endMaxWaitMs` | `6000` | 视频结束后等待平台标记的最长时间，超时强跳 |
| `forceAfterEnd` | `true` | 超时仍未标记时是否强制跳转 |
| `advanceDelayMs` | `5000` | 两次跳转之间的最小间隔，防抖 |
| `wrapAround` | `false` | 后面没有未完成任务点时是否回头找 |
| `jumpAlreadyDone` | `false` | 打开页面时该任务点此前已完成，是否也自动跳走 |

其它 localStorage 键：

| 键 | 值 | 说明 |
| --- | --- | --- |
| `cxAutoNext.enabled` | `1` / `0` | 面板「暂停」开关 |
| `cxAutoNext.autoPlay` | `1` / `0` | 面板「自动播放」开关 |
| `cxAutoNext.hop` | `<chapterId>` | 内部使用：记录本次是自己的跳转 |

## 工作原理

脚本按运行位置分两种角色：

```
┌─────────────────────────────────────────────┐
│ 顶层：/mycourse/studentstudy                  │
│  · 解析左侧目录 .posCatalog_select            │
│  · 用 URL 的 chapterId 定位"当前任务点"        │
│  · 完成后点击下一个未完成项 / 改 URL 兜底      │
└───────────────▲─────────────────────────────┘
                │ postMessage({__cxAutoNext, state:'ended'})
┌───────────────┴─────────────────────────────┐
│ 子帧：/ananas/modules/video/index.html        │
│  · 监听 <video> 的 ended / 进度 ≥ 99%         │
│  · 自动播放（含静音兜底）                      │
└─────────────────────────────────────────────┘
```

1. **定位当前任务点**：优先用地址栏 `chapterId`，其次 iframe 里的 `chapterId`，再次 `.posCatalog_active` 类名。
2. **判断完成**：目录项里的 `icon_Completed` / 「已完成」文本 / `title="已完成"`。
3. **跳转**：模拟点击目录项 → 点整行 → 点平台「下一节」→ 改 `chapterId` 参数，逐级降级，每级都写日志。
4. **结束看门狗**：收到 `ended` 后独立轮询（不等主循环），平台一标记立刻跳，超时强跳。
5. **后台保持**：`MutationObserver` + 媒体事件触发，不用 `setInterval` 等定时器，规避后台节流。

## 常见问题

**面板显示「没找到任务点」**
左侧章节目录可能没展开，或页面结构与预期不同。点「诊断」把输出发出来；也可以在 `@match` 里补上你所在学校的域名。

**一直显示「等待平台标记」**
1.4.0 已把这段逻辑从轮询里拆出来独立执行。若仍卡住，检查面板日志停在哪个环节（`点击都没生效` / `目标与当前地址相同`）。

**跳过去了，但视频不动**
先确认面板是「自动播放 开」。若课程前面有「开始学习 / 继续学习」弹窗，需要手动点一次；之后各节会自动接管。

**切到别的应用全屏后就不动了**
1.6.0 起支持。要注意部分课程带反作弊（失焦即暂停），这类课后台会被平台反复暂停，脚本会尝试拉起但可能来回拉锯。

**会不会误判，导致章节没标记完成却跳走**
会。`forceAfterEnd` 强跳时如果平台还没记录，该节点仍是未完成状态，需要在学习进度里补看。介意的话把 `endMaxWaitMs` 调大（例如 15000）。

## 目录结构

```
chaoxing-auto-next/
├── chaoxing-auto-next.user.js   # 用户脚本本体（发布用）
├── test/
│   ├── package.json             # 测试依赖（jsdom）
│   └── run.js                   # 23 项冒烟测试
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 开发与测试

```bash
cd test
npm install
npm test
```

测试用 [jsdom](https://github.com/jsdom/jsdom) 模拟学习通目录页与播放器 iframe，覆盖：完成即跳、跳过已完成、只点一次不重复跳、结束超时强跳、全部完成停止、暂停开关、子帧 `ended`/99% 上报、自动播放、静音兜底、后台仍播放、后台快速跳转。

如果想让 Tampermonkey 自动检查更新，在脚本头部补充（把地址换成你自己的仓库）：

```js
// @downloadURL  https://raw.githubusercontent.com/<your-name>/chaoxing-auto-next/main/chaoxing-auto-next.user.js
// @updateURL    https://raw.githubusercontent.com/<your-name>/chaoxing-auto-next/main/chaoxing-auto-next.user.js
```

## 免责声明

本项目仅用于减少重复的机械点击，**不会伪造观看进度、不会绕过平台的完成判定**。请遵守所在学校的规定与平台用户协议；因使用本脚本产生的一切后果由使用者自行承担。

## License

[MIT](LICENSE)
