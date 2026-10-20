# Nightpulse · 夜脉

中文 · [English](README.md)

**自主醒来，让经历接回主会话。**

Nightpulse 让 Claude Code Agent 在主会话的隔离分支里醒来，在配置好的权限内继续一段兴趣或未完事项，再为下一轮主对话留下有界的行动记录。一次唤醒可以行动、准备交接，也可以保持沉默。

本项目基于 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss)。底层聊天桥接、运行时适配、随机唤醒、提醒、日记与 Timeline 能力来自 Cyberboss；Nightpulse 的新增部分集中在隔离自唤醒，以及分支行动与主会话之间的连续性。

## Nightpulse 增加了什么

| 部分 | 实际行为 |
| --- | --- |
| 隔离自唤醒 | 从已经绑定的 Claude Code 主会话 fork，不重新绑定主会话，也不持久保存一份独立分支 transcript。 |
| 连续性状态 | 用小范围状态保留兴趣和未完方向；空更新保留原状态。 |
| 行动记录 | 配对工具调用与已识别的成功结果，及时记录已经完成的事情；后续超时或最终格式错误时仍保留这些记录。 |
| 回传主会话 | 在后续主输入末尾补入有界记录，仅在主回合成功结束后确认消费。 |
| 近期阅读索引 | 为 Garden 风格的帖子读取记录实际返回楼层和内容，帮助减少没有理由的重复完整阅读。 |
| 异常处理 | 不把已识别的“仍需确认”中间态记成完成动作；异常 JSON 解析能够正常结束，不再陷入无限循环。 |

运行过程：

```text
已有主会话
    |
定时自唤醒
    |
隔离分支 --------> 权限内的工具行动
    |                     |
可选的简短自述       配对的工具事实
    +---------------------+
                |
        私有本地行动记录
                |
      下一轮主输入 + 行动记录
                |
      回合成功：确认已消费
      失败或取消：保留待下轮重试
```

主会话收到的是紧凑记录与明确标注的分支自述，不是整段分支对话的合并。记录送达也不等于模型一定会正确理解或永久记住每个细节。

## 当前分享版的范围

新增的隔离自唤醒路径支持 **Claude Code**，需要**显式启用**。原有 Codex 支持与普通 check-in 行为继续沿用上游实现。这个分享版当前保留的是上游的**微信桥接**，本地另行部署的 Telegram 通道没有打包进来。

Nightpulse 不替换记忆数据库；已有记忆服务可以继续通过 MCP/API 接入。仓库分享程序代码和合成测试数据，不包含真实记忆或某个 Agent 的私人部署配置。

## 获取代码

需要 Node.js 22 或更新版本、Git，以及用于隔离唤醒的本地 Claude Code CLI。CLI 账号登录使用其正常流程另行完成。

```sh
git clone --branch codex/autonomous-wake --single-branch https://github.com/huk38786-max/nightpulse.git
cd nightpulse
npm install
```

为兼容现有调用，内部 package、命令、工具名、环境变量前缀与默认状态目录仍沿用 `cyberboss`。项目和仓库名称是 Nightpulse。

## 启用隔离自唤醒

先配置好底层桥接，并绑定已有的 Claude 主会话。[命令参考](docs/commands.md)说明了桥接入口；原有桥接的完整安装方式可参照[上游文档](https://github.com/WenXiaoWendy/cyberboss)。

在你自己的现有本地配置中补入以下选项，不要覆盖原有账号和工作区设置：

```dotenv
CYBERBOSS_RUNTIME=claudecode
CYBERBOSS_ENABLE_CHECKIN=1
CYBERBOSS_ISOLATED_CHECKIN=1
CYBERBOSS_ISOLATED_CHECKIN_TIMEOUT_MS=300000
CYBERBOSS_ISOLATED_CHECKIN_ALLOWED_TOOLS=mcp__example__read_item
```

上面的工具名只是占位示例，需要替换为你已检查过的确切 MCP 工具名。桥接审批处理器会处理 `ToolSearch` 和配置名单中的 MCP 工具请求；用户既有的权限和公开发布审批要求仍然适用。需要审批的动作应返回交接意图或完整草稿。

这一层不是操作系统沙箱。CLI 设置中已经预批准的工具可能不经过桥接审批，因此也需要核对 CLI 既有权限，不应开启跳过权限检查的参数。

改完配置后，通过自己的正常生命周期入口重启桥接。`/checkin <min>-<max>` 可以调整随机间隔；隔离路径需要已有父会话，不会自动另建一个会话来替代。

配置、数据保留和消费确认的细节见[隔离自唤醒说明](docs/autonomous-wakes.md)。

## 数据与限制

- 连续性状态和行动记录属于私有运行数据，不要把它们、聊天、日记、密钥或部署配置提交到仓库。
- 工具事实与分支自己的解释分别标记；工具返回成功不代表外部投递、发布或对方已读。
- 阅读索引只提供上下文，不能证明远端帖子没有变化。
- fork 不保证续缓存或节省额度。上下文前缀、CLI 行为、缓存过期与输出量都会影响用量。
- 测试使用合成数据和假 CLI；这里不使用他人的聊天截图作为 Nightpulse 的演示。

## 检查

```sh
npm run test:autonomous
npm run check
node --test test/*.test.js
```

完整测试在缺少原作者写死的本机路径时，有 4 项上游表情包测试失败。这些失败已经在未修改的上游基线上复现；评估修改时应结合对应测试输出判断。

## 来源与许可证

基于 [WenXiaoWendy/cyberboss](https://github.com/WenXiaoWendy/cyberboss)，保留上游许可证和版权声明。Nightpulse 的自唤醒扩展与本说明继续采用 [AGPL-3.0-only](LICENSE)。本 README 于 2026-10-20 重写，以描述当前 fork 的实际分享范围。
