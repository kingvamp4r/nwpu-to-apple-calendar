# Changelog

## 1.0.1 — 2026-09-28

- 增加 GitHub Raw 一键安装入口
- 增加 Tampermonkey `@updateURL` 与 `@downloadURL`
- 增加项目主页、问题反馈地址、作者和 MIT License 元数据
- 补充 README 中的安装、更新、隐私和兼容性说明
- 增加 MIT License

## 1.0.0 — 2026-09-28

- 首个稳定版本
- 自动截获西北工业大学新版教务系统课表与学期数据
- 根据 `weekIndexes`、`weekday` 和学期 `startDate` 计算实际上课日期
- 使用教务系统返回的 `startTime` / `endTime`
- 为每一次实际上课生成独立 iCalendar `VEVENT`
- 支持导出可由 Apple Calendar 导入的 `.ics`
