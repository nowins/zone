use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};

struct TaskEntry {
  signal: watch::Sender<bool>,
  users: usize,
  touched: Instant,
}
static TASKS: OnceLock<Mutex<HashMap<String, TaskEntry>>> = OnceLock::new();
tokio::task_local! { static TASK_SIGNAL: watch::Sender<bool>; }
const TASK_LIMIT: usize = 4096;
const CANCEL_TTL: Duration = Duration::from_secs(60);

fn validate_task_id(id: &str) -> Result<(), String> {
  if id.is_empty() || id.len() > 128 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
    return Err("播客网络任务标识无效".into());
  }
  Ok(())
}

struct TaskGuard(String);
impl Drop for TaskGuard {
  fn drop(&mut self) {
    if let Ok(mut tasks) = TASKS.get_or_init(Default::default).lock() {
      if let Some(entry) = tasks.get_mut(&self.0) {
        entry.users = entry.users.saturating_sub(1);
        entry.touched = Instant::now();
        if entry.users == 0 && !*entry.signal.borrow() { tasks.remove(&self.0); }
      }
    }
  }
}

fn prune(tasks: &mut HashMap<String, TaskEntry>) {
  tasks.retain(|_, entry| entry.users > 0 || entry.touched.elapsed() < CANCEL_TTL);
}

pub(crate) fn cancel_network_task(id: &str) -> Result<(), String> {
  validate_task_id(id)?;
  let mut tasks = TASKS.get_or_init(Default::default).lock().map_err(|_| "播客网络任务不可用".to_string())?;
  prune(&mut tasks);
  if let Some(entry) = tasks.get_mut(id) {
    entry.signal.send_replace(true);
    entry.touched = Instant::now();
  } else {
    if tasks.len() >= TASK_LIMIT { return Err("播客网络任务过多，请稍后重试".into()); }
    // Cancellation may reach IPC before the request or a delayed protocol GET.
    tasks.insert(id.into(), TaskEntry { signal: watch::channel(true).0, users: 0, touched: Instant::now() });
  }
  Ok(())
}

pub(crate) async fn run_network_task<T>(id: Option<&str>, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
  let Some(id) = id else { return future.await; };
  validate_task_id(id)?;
  let signal = {
    let mut tasks = TASKS.get_or_init(Default::default).lock().map_err(|_| "播客网络任务不可用".to_string())?;
    prune(&mut tasks);
    if !tasks.contains_key(id) && tasks.len() >= TASK_LIMIT { return Err("播客网络任务过多，请稍后重试".into()); }
    let entry = tasks.entry(id.into()).or_insert_with(|| TaskEntry { signal: watch::channel(false).0, users: 0, touched: Instant::now() });
    entry.users += 1;
    entry.signal.clone()
  };
  let _guard = TaskGuard(id.into());
  if *signal.borrow() { return Err("已取消播客网络请求".into()); }
  // Cancellation interrupts network awaits, not file/database transactions.
  TASK_SIGNAL.scope(signal, future).await
}

pub(crate) async fn network_io<T>(future: impl Future<Output = T>) -> Result<T, String> {
  let io = async {
    if let Some(deadline) = super::network_deadline() {
      if tokio::time::Instant::now() >= deadline { return Err("播客来源响应超时".into()); }
      tokio::time::timeout_at(deadline, future).await.map_err(|_| "播客来源响应超时".into())
    } else { Ok(future.await) }
  };
  let Ok(signal) = TASK_SIGNAL.try_with(Clone::clone) else { return io.await; };
  let mut receiver = signal.subscribe();
  if *receiver.borrow() { return Err("已取消播客网络请求".into()); }
  tokio::select! {
    value = io => value,
    _ = receiver.changed() => Err("已取消播客网络请求".into()),
  }
}

#[derive(Clone, Copy)]
pub(crate) enum NetworkClass { Metadata, Artwork, Stream, Download }
struct NetworkSlots { running: Arc<Semaphore>, admitted: Arc<Semaphore> }

fn create_network_slots() -> [NetworkSlots; 4] {
  [(4, 64), (4, 256), (6, 64), (2, 16)].map(|(count, capacity)| NetworkSlots {
    running: Arc::new(Semaphore::new(count)), admitted: Arc::new(Semaphore::new(capacity)),
  })
}

pub(crate) async fn with_network_limit<T>(class: NetworkClass, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
  static SLOTS: OnceLock<[NetworkSlots; 4]> = OnceLock::new();
  with_network_slots(SLOTS.get_or_init(create_network_slots), class, future).await
}

async fn with_network_slots<T>(slots: &[NetworkSlots; 4], class: NetworkClass, future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
  let slots = &slots[class as usize];
  let _admission = slots.admitted.clone().try_acquire_owned().map_err(|_| "播客网络任务过多，请稍后重试".to_string())?;
  let _permit = network_io(tokio::time::timeout(Duration::from_secs(30), slots.running.clone().acquire_owned())).await?
    .map_err(|_| "播客网络调度等待超时".to_string())?
    .map_err(|_| "播客网络调度已停止".to_string())?;
  future.await
}

pub(crate) fn protocol_task_id(uri: &tauri::http::Uri) -> Option<String> {
  uri.query()?.strip_prefix("requestId=").map(str::to_owned)
}

pub(crate) fn validate_protocol_query(uri: &tauri::http::Uri) -> Result<(), String> {
  if uri.query().is_none() { return Ok(()); }
  let id = protocol_task_id(uri).ok_or_else(|| "播客媒体地址参数无效".to_string())?;
  validate_task_id(&id)
}

#[cfg(test)]
mod tests {
  use super::*;
  #[tokio::test]
  async fn busy_downloads_do_not_take_stream_capacity() {
    let slots = Arc::new(create_network_slots());
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let release = Arc::new(tokio::sync::Notify::new());
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..2 {
      let barrier = barrier.clone(); let release = release.clone(); let slots = slots.clone();
      workers.spawn(async move {
        with_network_slots(&slots, NetworkClass::Download, async {
          let notified = release.notified(); tokio::pin!(notified); notified.as_mut().enable();
          barrier.wait().await;
          notified.await;
          Ok(())
        }).await
      });
    }
    tokio::time::timeout(Duration::from_secs(3), barrier.wait()).await.unwrap();
    let result = tokio::time::timeout(Duration::from_millis(200), with_network_slots(&slots, NetworkClass::Stream, async { Ok(42) })).await;
    release.notify_waiters();
    assert_eq!(result.unwrap().unwrap(), 42);
    while let Some(worker) = workers.join_next().await { worker.unwrap().unwrap(); }
  }
  #[tokio::test]
  async fn cancellation_before_registration_and_shared_readers_closes_io() {
    let id = format!("cancel-test-{}", super::super::unix_time_millis());
    cancel_network_task(&id).unwrap();
    let result = run_network_task(Some(&id), async { Ok::<_, String>(1) }).await;
    assert!(result.unwrap_err().contains("取消"));
    let id = format!("running-{id}");
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..2 {
      let id = id.clone();
      tasks.spawn(async move { run_network_task(Some(&id), async {
        network_io(std::future::pending::<()>()).await
      }).await });
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
    cancel_network_task(&id).unwrap();
    while let Some(result) = tokio::time::timeout(Duration::from_millis(100), tasks.join_next()).await.unwrap() {
      assert!(result.unwrap().unwrap_err().contains("取消"));
    }
  }
}
