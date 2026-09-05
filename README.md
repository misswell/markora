# Markora

一个本地优先、所见即所得的 Markdown 写作应用，目标是复刻 Typora 清爽而专注的编辑体验。

## 运行

```sh
npm install
npm run dev
```

桌面应用：

```sh
npm run desktop
```

## 已实现

- 所见即所得 Markdown 编辑与源码模式
- Markdown-aware 编辑内核与常用输入规则
- 文稿库、搜索、创建、重命名和删除
- 原生文件夹工作区、递归文稿列表和按需读取
- 自动保存到浏览器本地存储
- Markdown 文件导入与导出
- Tauri 原生文件打开、保存、另存为与路径状态
- 标题、强调、链接、列表、引用和代码格式工具
- GFM 表格、任务清单和删除线往返转换
- 专注模式、字数统计、浅色/深色外观
- 实时大纲、标题跳转和打字机模式
- 系统文件关联、双击打开与未保存修改保护
- 外部磁盘修改检测：查看中无本地改动时询问「重新加载 / 覆盖」，编辑中改动保留并在保存时确认

---

## 👨‍💻 作者的其他开源项目

**[MacPilot](https://github.com/misswell/MacPilot)** —— 开源 macOS 菜单栏效率工具箱（Swift 原生 · 零第三方依赖）：应用自动退出规则、BLE 靠近解锁、窗口切换器、剪贴板历史、平滑滚动、画中画、录屏、截图贴图等 11 合 1，Apple 公证签名，[免费下载](https://github.com/misswell/MacPilot/releases/latest)。觉得有用欢迎点个 Star ⭐
