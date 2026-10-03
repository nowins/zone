use reqwest::Url;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct ProxyEndpoint(String);

pub(crate) fn configured_proxy(scheme: &str, host: &str) -> Result<Option<ProxyEndpoint>, String> {
  if std::env::var("NO_PROXY").ok().is_some_and(|list| proxy_bypassed(&list, host)) { return Ok(None); }
  let configured = std::env::var("ZONE_PODCAST_PROXY").ok()
    .or_else(|| std::env::var(if scheme == "https" { "HTTPS_PROXY" } else { "HTTP_PROXY" }).ok())
    .or_else(|| system_proxy(scheme, host));
  let Some(value) = configured.filter(|value| !value.trim().is_empty()) else { return Ok(None); };
  if value.eq_ignore_ascii_case("direct") { return Ok(None); }
  let value = if value.contains("://") { value } else { format!("http://{value}") };
  let url = Url::parse(&value).map_err(|_| "播客 HTTP 代理配置无效".to_string())?;
  if url.scheme() != "http" || url.host_str().is_none() || url.fragment().is_some()
    || url.query().is_some() || url.path() != "/" {
    return Err("播客代理需使用 HTTP 代理地址".into());
  }
  Ok(Some(ProxyEndpoint(url.to_string())))
}

#[cfg(not(target_os = "windows"))]
fn system_proxy(_scheme: &str, _host: &str) -> Option<String> { None }

#[cfg(target_os = "windows")]
fn system_proxy(scheme: &str, host: &str) -> Option<String> {
  use windows::core::{w, PCWSTR};
  use windows::Win32::System::Registry::*;
  let path = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
  let mut enabled = 0u32;
  let mut length = 4u32;
  let enabled_status = unsafe { RegGetValueW(HKEY_CURRENT_USER, path, w!("ProxyEnable"), RRF_RT_REG_DWORD,
    None, Some((&mut enabled as *mut u32).cast()), Some(&mut length)) };
  if enabled_status.is_err() || enabled == 0 { return None; }
  let mut bypass_buffer = vec![0u16; 4096];
  let mut bypass_length = (bypass_buffer.len() * 2) as u32;
  let bypass_status = unsafe { RegGetValueW(HKEY_CURRENT_USER, path, w!("ProxyOverride"), RRF_RT_REG_SZ,
    None, Some(bypass_buffer.as_mut_ptr().cast()), Some(&mut bypass_length)) };
  if bypass_status.is_ok() {
    let end = bypass_buffer.iter().position(|value| *value == 0).unwrap_or(bypass_buffer.len());
    if String::from_utf16(&bypass_buffer[..end]).ok().is_some_and(|list| proxy_bypassed(&list, host)) { return None; }
  }
  let mut buffer = vec![0u16; 4096];
  let mut length = (buffer.len() * 2) as u32;
  let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, path, PCWSTR(w!("ProxyServer").as_ptr()), RRF_RT_REG_SZ,
    None, Some(buffer.as_mut_ptr().cast()), Some(&mut length)) };
  if status.is_err() { return None; }
  let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
  select_system_proxy(&String::from_utf16(&buffer[..end]).ok()?, scheme)
}

fn proxy_bypassed(list: &str, host: &str) -> bool {
  let host = host.to_ascii_lowercase();
  list.split([',', ';']).map(|item| item.trim().to_ascii_lowercase()).any(|item| {
    if item == "*" { return true; }
    if item == "<local>" { return !host.contains('.'); }
    if item.is_empty() { return false; }
    let item = item.strip_prefix("*.").or_else(|| item.strip_prefix('.')).unwrap_or(&item);
    host == item || host.strip_suffix(item).is_some_and(|prefix| prefix.ends_with('.'))
  })
}

fn select_system_proxy(value: &str, scheme: &str) -> Option<String> {
  if !value.contains('=') { return Some(value.trim().into()); }
  value.split(';').find_map(|entry| {
    let (protocol, address) = entry.split_once('=')?;
    protocol.trim().eq_ignore_ascii_case(scheme).then(|| address.trim().into())
  })
}

pub(crate) struct ProxyBridge {
  pub(crate) url: String,
  abort: tokio::task::AbortHandle,
}
impl ProxyBridge {
  pub(crate) fn is_finished(&self) -> bool { self.abort.is_finished() }
}
impl Drop for ProxyBridge { fn drop(&mut self) { self.abort.abort(); } }

// reqwest retains the original URL for Host, SNI and certificate validation.
// Only this local bridge talks to the configured proxy, with CONNECT targets
// expressed as validated numeric addresses. The proxy cannot resolve the origin.
pub(crate) fn start_proxy_bridge(endpoint: &ProxyEndpoint, host: &str, addresses: &[SocketAddr]) -> Result<Arc<ProxyBridge>, String> {
  let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "无法建立播客代理通道".to_string())?;
  listener.set_nonblocking(true).map_err(|_| "无法建立播客代理通道".to_string())?;
  let address = listener.local_addr().map_err(|_| "无法建立播客代理通道".to_string())?;
  // Cached bridges belong to the application runtime, rather than whichever
  // caller first requested this origin. A short-lived caller must not close
  // tunnels still leased by other requests.
  let runtime = tauri::async_runtime::handle();
  let listener = {
    let _enter = runtime.inner().enter();
    TcpListener::from_std(listener).map_err(|_| "无法建立播客代理通道".to_string())?
  };
  let endpoint = Url::parse(&endpoint.0).map_err(|_| "播客 HTTP 代理配置无效".to_string())?;
  let host = host.to_string();
  let addresses = addresses.to_vec();
  let task = tauri::async_runtime::spawn(async move {
    let mut tunnels = tokio::task::JoinSet::new();
    let mut next_address = 0usize;
    loop {
      tokio::select! {
        accepted = listener.accept() => {
          let Ok((stream, _)) = accepted else { break; };
          if tunnels.len() >= 16 { drop(stream); continue; }
          let endpoint = endpoint.clone(); let host = host.clone(); let mut addresses = addresses.clone();
          if !addresses.is_empty() {
            let offset = next_address % addresses.len();
            addresses.rotate_left(offset);
            next_address = next_address.wrapping_add(1);
          }
          tunnels.spawn(async move { let _ = bridge_connection(stream, endpoint, &host, &addresses).await; });
        }
        _ = tunnels.join_next(), if !tunnels.is_empty() => {}
      }
    }
  });
  Ok(Arc::new(ProxyBridge { url: format!("http://{address}"), abort: task.inner().abort_handle() }))
}

async fn read_headers(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
  let mut bytes = Vec::new();
  // Read exactly through the header terminator, leaving TLS/body bytes in TCP.
  while !bytes.ends_with(b"\r\n\r\n") {
    if bytes.len() >= 16 * 1024 { return Err(std::io::Error::other("proxy header too large")); }
    let mut byte = [0]; stream.read_exact(&mut byte).await?; bytes.push(byte[0]);
  }
  Ok(bytes)
}

async fn open_tunnel(endpoint: &Url, addresses: &[SocketAddr]) -> std::io::Result<TcpStream> {
  use base64::Engine;
  let proxy_host = endpoint.host_str().ok_or_else(|| std::io::Error::other("invalid proxy"))?.trim_matches(['[', ']']);
  let proxy_port = endpoint.port_or_known_default().unwrap_or(80);
  for address in addresses.iter().take(8) {
    let attempt = async {
      let mut stream = TcpStream::connect((proxy_host, proxy_port)).await?;
      let authorization = if !endpoint.username().is_empty() || endpoint.password().is_some() {
        // Configuration credentials are sent only to the selected proxy.
        let username = percent_encoding::percent_decode_str(endpoint.username()).decode_utf8()
          .map_err(|_| std::io::Error::other("invalid proxy credentials"))?;
        let password = percent_encoding::percent_decode_str(endpoint.password().unwrap_or_default()).decode_utf8()
          .map_err(|_| std::io::Error::other("invalid proxy credentials"))?;
        let credentials = format!("{username}:{password}");
        format!("Proxy-Authorization: Basic {}\r\n", base64::engine::general_purpose::STANDARD.encode(credentials))
      } else { String::new() };
      stream.write_all(format!("CONNECT {address} HTTP/1.1\r\nHost: {address}\r\n{authorization}\r\n").as_bytes()).await?;
      let headers = read_headers(&mut stream).await?;
      let status = std::str::from_utf8(&headers).ok().and_then(|headers| headers.lines().next())
        .and_then(|line| line.split_whitespace().nth(1));
      if status != Some("200") { return Err(std::io::Error::other("proxy CONNECT rejected")); }
      Ok::<_, std::io::Error>(stream)
    };
    if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(3), attempt).await { return Ok(stream); }
  }
  Err(std::io::Error::other("proxy connection failed"))
}

async fn bridge_connection(mut downstream: TcpStream, endpoint: Url, host: &str, addresses: &[SocketAddr]) -> std::io::Result<()> {
  let handshake = async {
    let headers = read_headers(&mut downstream).await?;
    let text = std::str::from_utf8(&headers).map_err(|_| std::io::Error::other("invalid proxy request"))?;
    let line = text.lines().next().ok_or_else(|| std::io::Error::other("invalid proxy request"))?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default(); let target = parts.next().unwrap_or_default();
    let port = addresses.first().ok_or_else(|| std::io::Error::other("missing pinned address"))?.port();
    let expected = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let origin = if method == "CONNECT" {
      if !target.eq_ignore_ascii_case(&expected) { return Err(std::io::Error::other("unapproved CONNECT destination")); }
      None
    } else if method == "GET" {
      let url = Url::parse(target).map_err(|_| std::io::Error::other("invalid proxy URL"))?;
      if url.scheme() != "http" || url.host_str().map(|host| host.trim_matches(['[', ']'])).unwrap_or_default() != host
        || url.port_or_known_default() != Some(port) || !url.username().is_empty() || url.password().is_some() {
        return Err(std::io::Error::other("unapproved proxy destination"));
      }
      let path = format!("{}{}", url.path(), url.query().map(|query| format!("?{query}")).unwrap_or_default());
      let mut origin = format!("GET {path} HTTP/1.1\r\nHost: {expected}\r\nConnection: close\r\n");
      for header in text.lines().skip(1).filter(|line| !line.is_empty()) {
        let name = header.split(':').next().unwrap_or_default().trim().to_ascii_lowercase();
        if !matches!(name.as_str(), "host" | "connection" | "proxy-connection" | "proxy-authorization") { origin.push_str(header); origin.push_str("\r\n"); }
      }
      origin.push_str("\r\n"); Some(origin)
    } else { return Err(std::io::Error::other("unsupported proxy method")); };
    let mut upstream = open_tunnel(&endpoint, addresses).await?;
    if let Some(origin) = origin { upstream.write_all(origin.as_bytes()).await?; }
    else { downstream.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?; }
    Ok::<_, std::io::Error>(upstream)
  };
  let mut upstream = tokio::time::timeout(Duration::from_secs(10), handshake).await
    .map_err(|_| std::io::Error::other("proxy handshake timeout"))??;
  let (mut down_read, mut down_write) = downstream.split();
  let (mut up_read, mut up_write) = upstream.split();
  // Finish both halves when either peer closes. No detached tunnel survives a
  // canceled response; idle keep-alive connections also have a finite lifetime.
  tokio::select! {
    result = copy_bounded(&mut down_read, &mut up_write) => result,
    result = copy_bounded(&mut up_read, &mut down_write) => result,
  }
}

async fn copy_bounded(reader: &mut (impl AsyncRead + Unpin), writer: &mut (impl AsyncWrite + Unpin)) -> std::io::Result<()> {
  let mut buffer = [0; 16 * 1024];
  loop {
    let read = tokio::time::timeout(Duration::from_secs(90), reader.read(&mut buffer)).await
      .map_err(|_| std::io::Error::other("proxy tunnel idle"))??;
    if read == 0 { return Ok(()); }
    tokio::time::timeout(Duration::from_secs(30), writer.write_all(&buffer[..read])).await
      .map_err(|_| std::io::Error::other("proxy tunnel stalled"))??;
  }
}


#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn windows_proxy_protocol_map_does_not_mix_http_and_https() {
    assert_eq!(select_system_proxy("http=127.0.0.1:80;https=127.0.0.1:81", "https").as_deref(), Some("127.0.0.1:81"));
    assert_eq!(select_system_proxy("http=127.0.0.1:80", "https"), None);
    assert!(proxy_bypassed("*.example.com; <local>", "media.example.com"));
    assert!(!proxy_bypassed("example.com", "fakeexample.com"));
    assert!(!proxy_bypassed("example.com", "example.com.attacker.com"));
  }

  #[tokio::test]
  async fn connect_uses_pinned_ip_and_keeps_the_original_authority_private() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = ProxyEndpoint(format!("http://{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.unwrap();
      let headers = String::from_utf8(read_headers(&mut stream).await.unwrap()).unwrap();
      assert!(headers.starts_with("CONNECT 93.184.216.34:443 HTTP/1.1"));
      assert!(!headers.contains("example.com"));
      stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
      let mut bytes = [0; 4]; stream.read_exact(&mut bytes).await.unwrap();
      assert_eq!(&bytes, b"ping"); stream.write_all(b"pong").await.unwrap();
    });
    let bridge = start_proxy_bridge(&endpoint, "example.com", &["93.184.216.34:443".parse().unwrap()]).unwrap();
    let url = Url::parse(&bridge.url).unwrap();
    let mut stream = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).await.unwrap();
    stream.write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n").await.unwrap();
    assert!(String::from_utf8(read_headers(&mut stream).await.unwrap()).unwrap().contains("200"));
    stream.write_all(b"ping").await.unwrap();
    let mut bytes = [0; 4]; stream.read_exact(&mut bytes).await.unwrap(); assert_eq!(&bytes, b"pong");
    server.await.unwrap();
    let mut invalid = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).await.unwrap();
    invalid.write_all(b"CONNECT localhost:80 HTTP/1.1\r\n\r\n").await.unwrap();
    let mut bytes = [0; 1];
    assert_eq!(tokio::time::timeout(Duration::from_millis(200), invalid.read(&mut bytes)).await.unwrap().unwrap(), 0);
  }

  #[tokio::test]
  async fn http_proxy_preserves_host_range_and_drops_proxy_credentials_before_origin() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = ProxyEndpoint(format!("http://user:pass@{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.unwrap();
      let headers = String::from_utf8(read_headers(&mut stream).await.unwrap()).unwrap();
      assert!(headers.starts_with("CONNECT 93.184.216.34:80"));
      assert!(headers.contains("Proxy-Authorization: Basic dXNlcjpwYXNz"));
      stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
      let headers = String::from_utf8(read_headers(&mut stream).await.unwrap()).unwrap();
      assert!(headers.starts_with("GET /audio?test=1 HTTP/1.1"));
      assert!(headers.contains("Host: example.com:80"));
      assert!(headers.to_ascii_lowercase().contains("range: bytes=0-3"));
      assert!(!headers.to_ascii_lowercase().contains("proxy-authorization"));
      stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nConnection: close\r\n\r\nID3x").await.unwrap();
    });
    let bridge = start_proxy_bridge(&endpoint, "example.com", &["93.184.216.34:80".parse().unwrap()]).unwrap();
    let client = reqwest::Client::builder().no_proxy().proxy(reqwest::Proxy::all(&bridge.url).unwrap()).build().unwrap();
    let response = client.get("http://example.com/audio?test=1").header("Range", "bytes=0-3").send().await.unwrap();
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"ID3x"); server.await.unwrap();
  }

  #[tokio::test]
  async fn successive_tunnels_rotate_validated_addresses_and_close_with_the_client() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = ProxyEndpoint(format!("http://{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
      for ip in ["93.184.216.34:443", "93.184.216.35:443"] {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = String::from_utf8(read_headers(&mut stream).await.unwrap()).unwrap();
        assert!(request.starts_with(&format!("CONNECT {ip} HTTP/1.1")));
        stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        let mut bytes = [0; 1];
        assert_eq!(tokio::time::timeout(Duration::from_millis(300), stream.read(&mut bytes)).await.unwrap().unwrap(), 0);
      }
    });
    let bridge = start_proxy_bridge(&endpoint, "example.com", &["93.184.216.34:443".parse().unwrap(), "93.184.216.35:443".parse().unwrap()]).unwrap();
    let url = Url::parse(&bridge.url).unwrap();
    for _ in 0..2 {
      let mut stream = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).await.unwrap();
      stream.write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n").await.unwrap();
      read_headers(&mut stream).await.unwrap(); drop(stream);
    }
    server.await.unwrap();
    bridge.abort.abort();
    tokio::time::timeout(Duration::from_secs(1), async {
      while !bridge.is_finished() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
  }

  #[tokio::test]
  async fn cached_bridge_outlives_the_runtime_of_its_first_caller() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = ProxyEndpoint(format!("http://{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
      let (mut stream, _) = listener.accept().await.unwrap();
      read_headers(&mut stream).await.unwrap();
      stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
      let mut bytes = [0; 4]; stream.read_exact(&mut bytes).await.unwrap();
      stream.write_all(&bytes).await.unwrap();
    });
    let bridge = std::thread::spawn(move || {
      let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
      runtime.block_on(async { start_proxy_bridge(&endpoint, "example.com", &["93.184.216.34:443".parse().unwrap()]).unwrap() })
    }).join().unwrap();
    let url = Url::parse(&bridge.url).unwrap();
    let mut stream = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).await.unwrap();
    stream.write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n").await.unwrap();
    read_headers(&mut stream).await.unwrap(); stream.write_all(b"ping").await.unwrap();
    let mut bytes = [0; 4]; stream.read_exact(&mut bytes).await.unwrap(); assert_eq!(&bytes, b"ping");
    server.await.unwrap();
  }
}
