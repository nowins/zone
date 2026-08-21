// 开发构建保留控制台以输出诊断日志，发布构建为纯 GUI 子系统
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  zone_player_lib::run();
}
