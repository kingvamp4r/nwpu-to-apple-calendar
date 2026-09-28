# NWPU → Apple Calendar

将西北工业大学新版教务系统课表一键导出为 Apple Calendar / iCalendar（`.ics`）文件的 Tampermonkey 用户脚本。

[直接安装 / 更新脚本](https://raw.githubusercontent.com/kingvamp4r/nwpu-to-apple-calendar/main/nwpu-to-apple-calendar.user.js)

## 功能

- 在西工大新版教务系统中自动读取当前课表
- 自动读取学期起止日期和教学周定义
- 正确处理单双周、非连续周次和同一课程不同周次的不同上课时间
- 使用教务系统返回的实际 `startTime` / `endTime`
- 将每一次实际课程生成独立的 `VEVENT`
- 导出标准 `.ics`，可直接导入 macOS / iPhone / iPad 的日历
- 不需要手动打开 DevTools，也不需要复制 Cookie、学号或密码
- 支持通过 GitHub Raw 地址由 Tampermonkey 检查脚本更新

## 已测试环境

- macOS
- Google Chrome
- Tampermonkey
- 西北工业大学新版教务系统：`https://jwxt.nwpu.edu.cn/student/home`

## 安装

### 推荐：一键安装

1. 先在 Chrome 中安装 Tampermonkey。
2. 点击：[安装 NWPU → Apple Calendar](https://raw.githubusercontent.com/kingvamp4r/nwpu-to-apple-calendar/main/nwpu-to-apple-calendar.user.js)
3. Tampermonkey 应自动打开脚本安装页，确认安装即可。

脚本元数据已经配置 `@updateURL` 和 `@downloadURL`。之后只要仓库中的版本号提高，Tampermonkey 即可按其自身更新策略检查新版。

### 手动安装

也可以新建一个 Tampermonkey 用户脚本，然后把 `nwpu-to-apple-calendar.user.js` 的完整内容复制进去。

## 使用

1. 登录西北工业大学教务系统。
2. 刷新 `https://jwxt.nwpu.edu.cn/student/home`。
3. 点击教务系统中的“课表”。
4. 页面右下角会出现 **NWPU → Apple Calendar** 面板。
5. 等待出现“课表数据读取完成”。
6. 点击 **下载 Apple Calendar ICS**。

脚本会下载当前学期的 `.ics` 文件。

## 导入 Apple 日历

在 Mac 上双击生成的 `.ics` 文件，然后选择目标日历。

如果希望同一个 Apple ID 下的 Mac、iPhone、iPad 自动同步，建议先在 Apple「日历」中创建一个 **iCloud 日历**（例如“NWPU 课表”），再把生成的 `.ics` 导入到这个 iCloud 日历。

本项目目前采用“一次导出、导入 iCloud”的方式，不依赖额外服务器。由于大学课表通常在开学前已经确定，这种方式比持续维护在线 ICS 订阅服务更简单可靠；若学期中发生调课或换教室，重新导出并更新即可。

## 工作原理

新版教务系统主页会以内嵌页面加载课表。脚本在同源页面中运行，监听教务系统自身已经发出的 XHR 请求，并读取：

- `/student/for-std/course-table/semester/.../print-data/...`
- `/student/ws/semester/get/...`

课表接口中的 `studentTableVm.activities` 提供生成日历所需的核心字段，包括：

- `courseName`
- `weekIndexes`
- `weekday`
- `startTime`
- `endTime`
- `room`
- `building`
- `campus`
- `teachers`

学期接口提供 `startDate` 和 `weekStartOnSunday`。脚本据此将“教学周 + 星期”转换为实际日期，再生成 iCalendar 事件。

当学期第一周周一为 `D0`，某课程位于第 `w` 周、星期 `d` 时：

```text
date = D0 + 7 × (w - 1) + (d - 1)
```

脚本不会把整门课程简单写成一个每周重复事件，而是按照 `weekIndexes` 为每一个实际上课周生成独立 `VEVENT`。因此可以自然处理单双周、非连续周、不同周次换星期或换教室等情况。

## 隐私与安全

脚本：

- 不保存或上传统一身份认证账号密码
- 不读取或导出浏览器 Cookie
- 不硬编码学号、学生关联 ID 或 semester ID
- 不向第三方服务器上传课表
- 所有课表解析和 ICS 生成均在浏览器本地完成

脚本只是读取教务系统页面自身已经取得的课表响应。生成的 `.ics` 文件会包含你的课程名称、教师、教室等课表信息，请自行妥善保管。

## 兼容性与限制

- 当前版本针对西北工业大学现行新版教务系统编写。
- 当前已验证的教学周定义为 `weekStartOnSunday === false`，即周一作为教学周首日。
- 如果学校升级教务系统并改变接口路径或 JSON 字段，脚本可能需要更新。
- 如果课表页面已经打开，再安装或启用脚本，建议刷新整个 `/student/home` 页面后重新进入课表。

## 更新

Tampermonkey 安装版包含：

```text
@updateURL
@downloadURL
```

二者均指向本仓库 `main` 分支的 Raw userscript。发布新版本时应同步提高脚本头部的 `@version`。

## License

MIT License，详见 [LICENSE](./LICENSE)。

## 文件

```text
nwpu-to-apple-calendar/
├── nwpu-to-apple-calendar.user.js
├── README.md
└── LICENSE
```

## 免责声明

这是一个非官方工具，与西北工业大学无隶属关系。请仅在你有权访问的个人教务系统账户中使用。
