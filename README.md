# dsh-meeting-asr（会议记录）

[DeepSeek Harness](https://api-docs.deepseek.com/) 插件：用 **DeepSeek 语音识别**（`POST /v1/tools/asr`）做会议记录，
逐字稿存到 `~/.dsh/meeting-notes/`，再由 DSH 出摘要、决议与待办。

除了云端识别，插件在**本地**做了三件云端不提供的事：

- **说话人分离**（单麦克风也能分人）：3D-Speaker 声纹 + 聚类，不额外调用任何接口
- **切段切在停顿处**：判定阈值跟着环境噪声底浮动，尽量不把词劈成两半
- **保存即自动命名**：用 DeepSeek 给逐字稿起一个能看出主题的中文标题

入口在左侧栏搜索图标旁边的麦克风按钮；设置页在「设置 → 插件 → 会议记录」。

## 三个页签

- **实时录音**：边说边出字，每段返回后立刻用在线声纹判定是谁说的。
- **文件转写**：选本机音视频（wav/mp3/m4a/mp4/mov/webm…），ffmpeg 解码后切段识别，进度可见。
- **记录库**：历史逐字稿，点开看 markdown、复制、交给 DSH 分析；鼠标悬浮可删除（连原音一起清）。

## 说话人分离怎么做的

单声道音频走本地声纹，不额外花钱：

1. 按能量切出语音片段，阈值跟着噪声底浮动
2. 每段用 3D-Speaker（ERes2Net，512 维）提取声纹
3. 平均连接聚类，连续同人片段合并 → `说话人1 / 说话人2 / …`
4. 实时录音走在线聚类：每段与场上已有的声纹库比对，够像就归同一个人

两个人交替说话的实测：同人相似度 0.91 / 0.80，不同人 0.47~0.53，四轮交替标注全对，20 秒音频耗时 266 ms。

- 模型：`~/.dsh/meeting-asr/models/speaker-embedding.onnx`（约 39 MB，首次使用自动下载，走 `gh-proxy` 加速）
- 运行时复用 Harness 自带的 `sherpa-onnx`，不额外装依赖
- 时长上限 60 分钟（要整段解码进内存）
- **人数据已知时请填上**（面板「说话人数」或工具的 `speakers`），自动模式在短句多、抢话多的生活场景会多分几个人

### 双通道：更可靠的另一条路

| 模式 | 做法 | 得到什么 |
|---|---|---|
| 单通道 | 一个麦克风 | 一路逐字稿，靠本地声纹标「说话人1/2」 |
| 双通道 · 双麦克风 | 两个输入设备各录一位 | 「说话人A / 说话人B」按时序交错 |
| 双通道 · 麦克风 + 系统声音 | 麦克风 = 我，系统声音 = 参会者 | 「我 / 参会者」 |

双通道是两路独立识别再按时间戳合并，比声纹推断更准，能用就用。

## 准确率的几个关键点

- **切段切在停顿处**：停顿超过 0.45 秒就切；到 30 秒硬上限时，在最后 8 秒里挑最安静的位置切。
- **保留原音**：实时录音会把原音（16k 单声道）存到 `~/.dsh/meeting-notes/audio/`，面板上可「精转」用整段重跑一遍。
- **现场三件事**：用耳机、离麦克风 10–20cm、别外放。

## 自动命名

保存时 Host 直接调用 DeepSeek 的 `chat/completions`（用你已经配好的 key）从逐字稿生成 8–14 字标题，
文件名、markdown 标题、索引一起改；失败或断网就保留时间戳标题，不阻塞转写。
想关掉：`~/.dsh/meeting-asr.json` 里加 `"autoName": false`。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `meeting_transcribe(file_path, dual_track?, speakers?, title?, wait?)` | 本机音视频转写，自动切段、声纹分人、存库 |
| `meeting_notes_list(limit?)` | 最近逐字稿 |
| `meeting_notes_read(id, max_chars?)` | 读原文 markdown |
| `meeting_notes_rename(id, title)` | 改标题（文件名一起改） |
| `meeting_notes_delete(id)` | 删记录（markdown + 原音 + 索引） |

## 安装

需要先装好 DeepSeek Harness（本插件依赖它自带的 `sherpa-onnx` 与 Cordis 运行时）。

```sh
git clone https://github.com/vines90/dsh-meeting-asr.git
dsh plugin --profile desktop add /绝对路径/dsh-meeting-asr
```

或在 DSH 里让 agent 用 `plugin_manager` 的 `install_bundle` 指向这个目录。
装完**重启** DeepSeek Harness——Host 端依赖模块只在重启后才会换成新代码。

依赖：

- `ffmpeg` / `ffprobe`（文件转写用，实时录音不需要）
- 一个 DeepSeek API Key（面板里填，存在 DSH 凭证 `DEEPSEEK_ASR_API_KEY`，兜底 `DEEPSEEK_API_KEY`）

## 密钥与限制

- key 只存在 Host 进程，面板通过同源 HTTP 路由调用，不会出现在浏览器或日志里
- 单请求：16-bit PCM WAV / Ogg Opus，≤120 秒，≤8 MiB，无流式；插件按 60 秒切段
- 计费按音频时长，官网限时价约 ¥0.39/小时；面板上的费用是估算
- DeepSeek ASR 不返回逐词时间戳，逐字稿里的方括号是**切片起点**，同一片内的先后不分；重要结论请回听原音
- 说话人不确定的地方，逐字稿会如实标注，不会编造人名

## 许可

MIT
