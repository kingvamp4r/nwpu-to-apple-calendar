# NWPU → Apple Calendar

将西北工业大学新版教务系统课表一键导出为 Apple Calendar / iCalendar（`.ics`）文件的 Tampermonkey 用户脚本。

## 功能

- 在西工大新版教务系统中自动读取当前课表
- 自动读取学期起止日期和教学周定义
- 正确处理单双周、非连续周次和同一课程不同周次的不同上课时间
- 使用教务系统返回的实际 `startTime` / `endTime`
- 将每一次实际课程生成独立的 `VEVENT`
- 导出标准 `.ics`，可直接导入 macOS / iPhone / iPad 的日历
- 不需要手动打开 DevTools，也不需要复制 Cookie、学号或密码

## 环境

已在以下环境完成实际测试：

- macOS
- Google Chrome
- Tampermonkey
- 西北工业大学新版教务系统：`https://jwxt.nwpu.edu.cn/student/home`

## 安装

1. 安装 Tampermonkey。
2. 新建一个用户脚本。
3. 将仓库中的 `nwpu-to-apple-calendar.user.js` 全部复制进去并保存。
4. 登录西北工业大学教务系统。
5. 刷新 `https://jwxt.nwpu.edu.cn/student/home`。
6. 点击教务系统中的“课表”。

页面右下角会出现 **NWPU → Apple Calendar** 面板。读取完成后点击：

> 下载 Apple Calendar ICS

即可得到当前学期课表的 `.ics` 文件。

## 导入 Apple 日历

在 Mac 上双击生成的 `.ics` 文件，选择要导入的日历即可。

如果希望同一个 Apple ID 下的 Mac、iPhone、iPad 自动同步，建议先在 Apple「日历」中创建一个 **iCloud 日历**（例如“NWPU 课表”），然后将 `.ics` 导入到该 iCloud 日历。

## 工作原理

新版教务系统主页会以内嵌页面加载课表。脚本运行在同源页面中，监听教务系统自身发出的 XHR 请求，并读取：

- `/student/for-std/course-table/semester/.../print-data/...`
- `/student/ws/semester/get/...`

课表接口中的 `studentTableVm.activities` 已提供生成日历所需的核心字段，包括：

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

当前脚本在 `weekStartOnSunday === false` 的教学周定义下工作。

## 隐私

脚本：

- 不保存或上传统一身份认证账号密码
- 不读取或导出浏览器 Cookie
- 不硬编码学号、学生关联 ID 或 semester ID
- 不向第三方服务器上传课表
- 所有课表解析和 ICS 生成均在浏览器本地完成

生成的 `.ics` 文件会包含你自己的课程名称、教师、教室等课表信息，请自行妥善保管。

## 注意事项

这是一个非官方工具，与西北工业大学无隶属关系。

脚本依赖当前新版教务系统的页面结构与接口。如果学校未来升级教务系统，接口路径或 JSON 字段可能发生变化。

建议每学期开学前重新从教务系统导出一次课表；如遇调课、换教室等情况，可重新导出。

## 文件

```text
nwpu-to-apple-calendar/
├── nwpu-to-apple-calendar.user.js
└── README.md
```
