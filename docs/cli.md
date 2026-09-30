# CLI 使用

CLI 用于驱动服务端和执行端到端检查。先完成[本地运行](development.md)，配置 `WEBCLIP_URL`、`WEBCLIP_TOKEN` 和 `WEBCLIP_USER`。前两项必填，用户标识默认是 `cli`。以下命令在仓库根目录执行；`<session>` 替换为创建会话返回的 ID。

```bash
export WEBCLIP_URL=http://localhost:8787
export WEBCLIP_USER=me
# WEBCLIP_TOKEN 设置为服务端 AUTH_TOKEN 的值

npm run cli -- new "某个页面"          # 建会话
npm run cli -- prompt "…"              # 跑一轮，流式打印；会话自动建
npm run cli -- prompt <session> "…"    # 接着某个会话跑
echo "你好啊" | npm run cli -- chat     # 一句话就说完，会话自动建
npm run cli -- chat                    # 连续对话，每行一轮
npm run cli -- chat <session>          # 接着已有会话聊
npm run cli -- events <session> 0      # 回放并跟随
npm run cli -- timeline <session>      # 这一轮的时间花在哪
npm run cli -- sessions                # 列表
npm run cli -- abort <session>
npm run cli -- rm <session>           # 删除会话
```

`chat` 里以 `/` 开头的行是命令，其余按原文发送；想发以斜杠开头的文本就写 `//`。

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/list` | 所有会话，当前一条标 `*` |
| `/new [title]` | 新建并切过去 |
| `/switch <session>` | 切到已有会话 |
| `/session` | 当前会话、游标、暂存文件 |
| `/history [since]` | 回放本会话的日志 |
| `/file [path\|clear]` | 为下一条消息暂存文件 |
| `/gzip` | 切换上传是否压缩 |
| `/abort` | 标记当前轮次为中止 |
| `/rm [session]` | 删除会话，默认当前 |
| `/quit` | 退出 |

交互命令与别名以 `/help` 为准，它由 [CLI 的命令定义](../cli/index.mjs)生成。切换会话会把游标归零：序号只在产生它的那条日志里有意义。


**首轮带上网页与截图**：

```bash
npm run cli -- prompt \
  --file ./source.html --file ./screenshot.png --gzip \
  "读 source.html，把报价做成 widget"
```

会话可省：不给就新建一个并打印它的 id。首个位置上的裸 UUID 当作会话，`--session <id>` 是它的显式写法。

`--file` 可给零个、一个或多个，文件写入工作区根目录：路径中的目录部分会被剥掉，`./a/b/source.html` 落成 `/source.html`，所以提示词里直接按文件名引用。`--gzip` 只压缩文本类扩展名——服务端解压后再落盘，因此 `grep` 看到的是真实字节；PNG 之类不会被再压一遍。


`abort` 的执行限制、回放与重连语义见[客户端协议](protocol.md)。CLI 的 `events` 读取一次流；网络断开后需要再次调用并传入已收到的游标。
