# Debian 服务器订阅模式

采集器保存私有 JSON 快照，发布器生成标准 ICS，HTTP 服务只提供带随机令牌的订阅路径。

将项目放在 Debian 用户的 `~/nwpu-to-apple-calendar`。安装：

```bash
sudo apt update
sudo apt install python3-venv chromium xvfb xauth
cd ~/nwpu-to-apple-calendar
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

工具使用系统 Chromium，不额外下载 Playwright 浏览器。
使用普通浏览器启动方式、独立的持久配置目录，并通过仅监听本机的 CDP 连接读取响应。
已在 Wyse 验证此启动方式可显示登录页；原自动化启动方式遇到 412 后返回 400 空白页。

## 首次登录

在服务器的图形桌面或现有的、通过 Tailscale 访问的远程桌面中执行：

```bash
cd ~/nwpu-to-apple-calendar
.venv/bin/python collector.py login
```

在打开的 Chromium 中自行输入账号和手机验证码，再进入**本学期课表**。
工具等待最长 10 分钟，自动捕获两个已知接口的有效响应后保存状态并关闭浏览器。
无图形桌面时需要先配置安全的远程桌面；不要将 VNC 或浏览器调试端口公开。
工具不会收集或代填验证码。

```bash
xvfb-run -a .venv/bin/python collector.py check
.venv/bin/python collector.py status
```

`check` 在虚拟显示中运行普通浏览器，复用私有配置目录，并从上次成功快照恢复会话 Cookie。
随后在真实页面中调用首次采集的接口，以保持浏览器请求身份一致。
已在 Wyse 完成人工验证码登录及一次独立后台采集，返回 42 个课表块且内容一致；长期有效期仍待观察。
如果 API 需要额外页面请求头、动态参数或 sessionStorage，实际检查可能失败，需要根据服务器上的真实响应继续适配。
`check_failed` 不一定是登录失效，也可能是网络、接口变化或响应格式问题。
没有成功样本前不能确认教务会话有效期或长期无人值守能力。

`data/` 包含登录凭证、个人接口地址与课表，默认仅当前用户可读，并已排除出 Git。
不要通过 Tunnel 对外提供该目录。每次成功检查会保存服务器续发的会话状态。

## 开启每日观察

确认手动 `check` 成功后，先初始化并生成第一份订阅内容：

```bash
.venv/bin/python subscription.py init
.venv/bin/python subscription.py publish
```

然后安装服务和定时任务：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/nwpu-check.* ~/.config/systemd/user/
cp deploy/nwpu-calendar.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now nwpu-calendar.service
systemctl --user enable --now nwpu-check.timer
```

服务器需要允许用户服务在退出 SSH 后继续运行：由管理员执行 `sudo loginctl enable-linger kv`。
使用 `journalctl --user -u nwpu-check.service` 查看结果。暂未实现外部失败通知或自动重试。
仅在采集成功后发布新 ICS；数据无变化时文件内容与更新时间保持不变。
观察 `status` 的 `last_login`、`last_success`、`last_attempt` 和 `error`，连续检查失败时重新执行 `login`。
定时任务会刷新会话，因此观察的是每日使用条件下的有效期，并非完全闲置时的过期时间。

跨学期时重新登录并打开新学期课表，以更新接口地址。

## Cloudflare Tunnel 与 Apple Calendar

在已有 Tunnel 添加已发布应用：`cal.你的域名` → `http://127.0.0.1:8791`。
不需要在路由中填写文件路径；HTTP 服务自行校验精确的随机令牌地址。
初次添加可自动创建 DNS 记录；不要修改已有站点的路由。
ICS 路径不能要求交互式 Cloudflare Access 登录，否则日历客户端无法自动刷新。

在服务器上查询自己的订阅地址（请勿公开输出）：

```bash
.venv/bin/python -c 'import json; print("https://cal.你的域名/" + json.load(open("data/subscription.json"))["token"] + ".ics")'
```

Mac「日历」→「文件」→「新建日历订阅」→ 输入完整 HTTPS 地址 → 选择 iCloud，设置自动刷新。
旧的手动导入日历应隐藏或在确认订阅内容后删除，避免看见两份课程。
服务器检查时间与 Apple 客户端刷新时间独立，订阅不能保证实时更新。

订阅是只读的。UID 不含时间与教室；匹配成功的调课保留 UID 并递增 SEQUENCE。
同一课程同一教学周只有一个待变更事件时可追踪改期；多个事件同时变化且无法确定对应关系，
或跨教学周改期时，使用“取消旧事件、新增事件”，不会猜测课程对应关系。
被取消的事件以 `STATUS:CANCELLED` 留在订阅中，实际显示方式由客户端决定。
全空课表响应需要人工检查，发布器会拒绝用它清空已有订阅。

要更换订阅令牌：修改私有 `data/subscription.json` 中的 token 为新生成的长随机字符串，
重启 `nwpu-calendar.service`，再更新所有设备上的订阅地址。旧地址立即失效（客户端可能保留缓存）。
通过 `collector.py status` 查看最近成功时间；会话失效时通过受保护的远程桌面重新执行 `login`，
然后运行 `subscription.py publish`。

## 浏览器上传与考试订阅

升级用户脚本到 1.1.0 后，在教务系统左下角“配置”填写课表与考试 HTTPS 订阅链接，
以及独立的 `upload_token`。三项配置保存在 Tampermonkey 脚本存储，不提交到 GitHub。
`subscription.py init` 会在保留旧课表令牌的同时补齐考试令牌和上传令牌。

打开“考试信息”读取页面表格，包含隐藏的已结束记录。点击“上传考试”同步全部已读取记录；
“自动上传：开/关”开启后，打开课表或考试页面时自动上传。服务器每日定时检查目前只采集课表，
考试更新依赖浏览器访问考试页面，不会自动登录另一端而踢掉正在使用的会话。

`POST /api/upload` 只接受独立 Bearer 上传凭证，订阅令牌不能写入。
考试订阅沿用同一域名和服务端口，路径为 `/<exam_token>.ics`，无需修改 Tunnel。
考试列表没有可靠记录 ID，因此改期匹配存在边界：同学年同课程同考试类型的单场变更保留 UID，
复杂多场变更按取消加新增处理；页面遗漏的记录始终保留，不能据此推断取消考试。
当前页面未提供座位号或考试要求，不生成或猜测这些字段。

## 邀请制多人使用（1.3.0）

每人使用自己的教务登录与设备，服务端不为新增用户保存教务 Cookie、账号密码或验证码。
管理员仅通过 SSH/Tailscale 执行命令，不提供公网管理接口。

```bash
cd ~/nwpu-to-apple-calendar
# 创建一个人，打印 user_id 与十分钟有效的一次性配对码
.venv/bin/python accounts.py create-user '用户备注'
# 同一个人增加设备，订阅链接不变，每台设备的上传密钥独立
.venv/bin/python accounts.py pair-device USER_ID
# 查看用户与设备 ID、状态、设备上次请求时间（不显示凭证）
.venv/bin/python accounts.py list
# 撤销丢失设备，不影响其他设备或已有订阅
.venv/bin/python accounts.py revoke-device DEVICE_ID
# 停用整个人：其所有上传凭证和订阅链接均拒绝访问，数据暂时保留
.venv/bin/python accounts.py disable-user USER_ID
```

只把配对码私下交给对应的人；脚本安装地址可公开分享：
`https://cal.kingvamp.asia/client.user.js`。公开脚本不包含个人链接或凭证。
用户安装后展开“新设备配对”，填写服务地址、配对码及设备备注，即可取得自己的上传凭证及订阅链接。
配对码失效或请求结果不明时，由管理员检查设备列表、撤销多余设备，再签发新码；不要重复使用旧码。
已有配置的设备再次配对会切换本机用户；原用户的其他设备和订阅不会被修改。

数据库为私有 `data/accounts.sqlite3`，新用户数据在 `data/users/USER_ID/`。
设备上传密钥只保存哈希；订阅令牌需保存在私有数据库中用于分发和查找。
首次启动自动把旧单用户配置登记为 `owner`，原订阅路径、上传密钥、UID 与数据目录保持不变。
个人每日采集仍只针对 owner，新增用户完全依赖各自浏览器上传。

服务根据上传凭证定位用户，忽略请求中的 user_id；订阅凭证不能上传。
每请求最多 2 MB、课表最多 500 块/20000 事件、考试最多 500 条。
同一设备上传间隔至少 0.5 秒；配对接口整个实例每分钟最多 30 次尝试。
并发更新同一个人的数据按用户锁串行执行，使用最后一次成功上传的内容。

停用不等于删除。接到删除请求时，管理员先停用对应用户，再按 user_id 定位并清理其数据和备份；
当前版本不提供自助删除、找回或重新启用界面。备份数据库时需停止服务或使用 SQLite backup API，
并连同各用户的日历与事件映射一起保存，避免丢失 UID 导致客户端重复。
