# Design QA

## Scope

- 信息查找对话框：Zune 4.8“查找专辑信息”参考
- 信息编辑对话框：Zune 4.8“编辑专辑信息”参考
- 添加到播放列表：Zune 4.8“选择一个播放列表”参考
- 音乐右键菜单：Zune 4.8 紧凑菜单参考

## Source references

- `C:\Users\mirac\AppData\Local\Temp\codex-clipboard-2fb6ad28-158c-449b-974c-c4d477dd97e9.png`
- `C:\Users\mirac\AppData\Local\Temp\codex-clipboard-6f4b2dbf-8367-44cb-baf5-b6699f84c9f4.png`
- `C:\Users\mirac\AppData\Local\Temp\codex-clipboard-4db11d00-ee29-46bf-a1c4-95b394076b82.png`
- `C:\Users\mirac\AppData\Local\Temp\codex-clipboard-0ad24e9e-8793-49a4-a912-fde2251b0b23.png`
- `C:\Users\mirac\AppData\Local\Temp\codex-clipboard-b4eab9b6-0b05-4d29-860a-dff74d19bef6.png`

## Implementation checks

- Context menu width reduced from 282px to 226px; title block removed; item height reduced to 33px.
- Playlist choices moved out of the context menu into a bounded, scrollable modal.
- Playlist chooser lists every eligible manual playlist, excludes favorites, smart playlists, and the source playlist.
- “新建播放列表” creates the playlist and adds the selected tracks atomically.
- Metadata search and edit use centered, square-cornered Zone dialogs with a thin accent edge, cover summary, compact controls, and explicit confirm/cancel actions.
- Search query can correct the entity name without modifying file tags.
- Manual edits persist through the native metadata database and retain the original local file metadata.
- Overlay opening and closing uses the existing `Presence` motion lifecycle and shared motion durations.
- Chinese UI guard, TypeScript build, Node tests, Rust check, and Rust unit tests pass.

## Visual comparison

No implementation screenshot was captured. The project instructions prohibit automatically starting the Tauri development app, and no running Zone window was available during QA. A reference-versus-rendered comparison therefore could not be completed in this turn.

## Final result

blocked

The implementation is ready for a user-started Tauri session. Visual sign-off requires checking the three dialogs and the context menu in the real default-size window, then recording a rendered screenshot comparison here.
