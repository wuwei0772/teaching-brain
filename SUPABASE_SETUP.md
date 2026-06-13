# Supabase 启用步骤

应用代码已经切换为 Supabase 实时存储。首次启用时完成以下步骤：

1. 在 Supabase Dashboard 打开 **SQL Editor**。
2. 按顺序执行共享数据平台中的迁移：
   - `../teaching-data-platform/supabase/migrations/202606110001_unified_content.sql`
   - `../teaching-data-platform/supabase/migrations/202606130001_teaching_platform.sql`
3. 在 **Authentication > Providers > Email** 中启用 Email 登录。
4. 打开应用，在顶部填写：
   - Supabase Project URL
   - Publishable key（旧项目也可使用 anon key）
   - 登录邮箱和密码
5. 首次使用点击“注册”，完成邮箱验证后登录。

登录成功后：

- 新增、修改和删除内容都会写入 `public.content_items`。
- 每次内容修改都会自动写入 `public.content_versions`。
- 上传文件会进入私有 Bucket `teaching-brain-files`，元数据写入 `public.attachments`。
- 其他已登录窗口会通过 Supabase Realtime 自动刷新。
- 浏览器中旧的 `teaching_brain_outcomes_v1` 案例会自动迁移一次。
- 教案、教师查看记录和教师反馈由 Teaching Plan 与 Teaching Brain 共享。

数据库迁移、权限和导入工具的唯一维护位置是相邻的
`teaching-data-platform` 项目。本仓库中的早期迁移文件仅为兼容保留。

未来教案生成模块可调用页面全局函数：

```js
const saved = await saveLessonPlan({
  title: 'FCE Writing Lesson 1',
  status: 'draft',
  content: {
    objectives: ['掌握议论文结构'],
    activities: []
  }
});
```

更新已有教案时传入 `id`，数据库会自动保留新版本：

```js
await saveLessonPlan({
  id: saved.id,
  title: saved.title,
  status: 'published',
  content: updatedLessonPlan
});
```
